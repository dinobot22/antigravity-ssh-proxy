import * as vscode from 'vscode';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { generateSetupScript, generateRollbackScript } from './remoteSetup';
import { StatusManager } from './statusManager';
import { DiagnosticPanel } from './diagnostics/diagnosticPanel';
import { TrafficPanel } from './traffic/trafficPanel';
import { formatTargetAppsEnv, getConfiguredTargetApps } from './targets';
import {
	applyCodexProfileSnapshot,
	restoreLatestCodexProfileBackup
} from './codexProfile';
import {
	getCodexHistoryBuckets,
	previewCodexHistoryRebucket,
	rebucketCodexHistory,
	restoreLatestCodexHistoryBackup
} from './codexHistory';
import {
	CodexProfileBridgeServer,
	fetchCodexProfileSnapshotFromBridge,
	getRemoteCodexProfileBridgePort,
	LOCAL_CODEX_PROFILE_BRIDGE_PORT
} from './codexProfileBridge';

const execAsync = promisify(exec);

let outputChannel: vscode.OutputChannel;
let statusManager: StatusManager;
let diagnosticPanel: DiagnosticPanel;
let trafficPanel: TrafficPanel;
let codexProfileBridgeServer: CodexProfileBridgeServer | undefined;

function log(message: string): void {
	const timestamp = new Date().toISOString();
	const location = isRunningLocally() ? '[LOCAL]' : '[REMOTE]';
	outputChannel?.appendLine(`${timestamp} ${location} ${message}`);
}

function isRunningLocally(): boolean {
	return !vscode.env.remoteName;
}

async function checkPortAvailable(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = new net.Socket();
		socket.setTimeout(1000);
		socket.on('connect', () => { socket.destroy(); resolve(true); });
		socket.on('timeout', () => { socket.destroy(); resolve(false); });
		socket.on('error', () => { socket.destroy(); resolve(false); });
		socket.connect(port, host);
	});
}

/**
 * Check if mgraftcp is currently running (i.e., Language Server is using proxy)
 */
async function isMgraftcpRunning(): Promise<boolean> {
	try {
		const { stdout } = await execAsync('pgrep -f mgraftcp');
		return stdout.trim().length > 0;
	} catch {
		// pgrep returns non-zero if no process found
		return false;
	}
}

/**
 * Get Language Server process info
 * Returns PID and whether it's running in persistent mode
 * 
 * When LS runs through mgraftcp, ps shows two processes:
 * 1. mgraftcp process (parent, contains "language_server_linux" as argument)
 * 2. actual language_server process (child, the .bak binary)
 * 
 * We need to find the actual LS process and determine if it was started via mgraftcp
 */
async function getLanguageServerProcess(): Promise<{ pid: number; isPersistent: boolean; isUsingProxy: boolean } | null> {
	try {
		const { stdout } = await execAsync('ps aux | grep language_server_linux | grep -v grep');
		const lines = stdout.trim().split('\n').filter(l => l.length > 0);
		
		// First pass: check if mgraftcp is wrapping the LS (indicates proxy is active)
		const hasMgraftcpWrapper = lines.some(line => line.includes('mgraftcp'));
		
		// Second pass: find the actual LS process (not the mgraftcp line)
		for (const line of lines) {
			// Skip the mgraftcp wrapper line, we want the actual LS binary
			if (line.includes('mgraftcp-fakedns')) {
				continue;
			}
			
			// Look for the actual language_server process (either direct or .bak)
			if (line.includes('language_server_linux')) {
				const parts = line.split(/\s+/);
				if (parts.length >= 2) {
					const pid = parseInt(parts[1]);
					const isPersistent = line.includes('--persistent_mode') || line.includes('persistent_mode');
					
					if (!isNaN(pid)) {
						return { 
							pid, 
							isPersistent, 
							isUsingProxy: hasMgraftcpWrapper 
						};
					}
				}
			}
		}
	} catch {
		// No process found
	}
	return null;
}

/**
 * Kill Language Server process to force restart through wrapper
 * This is needed when LS is running in persistent_mode and was started before wrapper was configured
 */
async function killLanguageServer(): Promise<boolean> {
	const lsProcess = await getLanguageServerProcess();
	if (!lsProcess) {
		log('No Language Server process found to kill');
		return false;
	}
	
	try {
		log(`Killing Language Server process (PID: ${lsProcess.pid}, persistent: ${lsProcess.isPersistent})`);
		await execAsync(`kill ${lsProcess.pid}`);
		
		// Wait a bit for process to terminate
		await new Promise(resolve => setTimeout(resolve, 1000));
		
		// Verify it's gone
		const stillRunning = await getLanguageServerProcess();
		if (stillRunning && stillRunning.pid === lsProcess.pid) {
			log('Process still running, using SIGKILL');
			await execAsync(`kill -9 ${lsProcess.pid}`);
		}
		
		log('Language Server process killed successfully');
		return true;
	} catch (error) {
		log(`Failed to kill Language Server: ${error}`);
		return false;
	}
}

/**
 * Show reload window prompt with optional auto-reload after timeout
 */
function promptReloadWindow(message: string): void {
	vscode.window.showInformationMessage(
		message,
		'Reload Now',
		'Later'
	).then(selection => {
		if (selection === 'Reload Now') {
			vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	});
}

const ANTIGRAVITY_FILENAME = 'config.antigravity';
const INCLUDE_LINE = `Include ${ANTIGRAVITY_FILENAME}`;

/**
 * Get path to SSH config directory based on platform
 */
function getSSHDir(): string {
	return path.join(os.homedir(), '.ssh');
}

/**
 * Get path to the main SSH config file
 */
function getSSHConfigPath(): string {
	return path.join(getSSHDir(), 'config');
}

/**
 * Get path to our custom SSH config file
 */
function getAntigravityConfigPath(): string {
	return path.join(getSSHDir(), ANTIGRAVITY_FILENAME);
}

/**
 * Update the SSH config files using the Include approach
 */
async function updateSSHConfigFile(
	remotePort: number,
	localPort: number,
	enable: boolean,
	codexBridgeRemotePort: number
): Promise<void> {
	const mainConfigPath = getSSHConfigPath();
	const antiConfigPath = getAntigravityConfigPath();

	try {
		// Ensure .ssh directory exists
		await fs.mkdir(getSSHDir(), { recursive: true });

		if (enable) {
			// 1. Create/Update the config.antigravity file
			const antiContent = [
				'# Antigravity SSH Proxy Configuration',
				`# Generated at: ${new Date().toISOString()}`,
				'Match all',
				`    RemoteForward ${remotePort} 127.0.0.1:${localPort}`,
				`    RemoteForward ${codexBridgeRemotePort} 127.0.0.1:${LOCAL_CODEX_PROFILE_BRIDGE_PORT}`,
				'    ExitOnForwardFailure no',
				'    VisualHostKey no',
				'',
			].join('\n');
			await fs.writeFile(antiConfigPath, antiContent, 'utf-8');
			log(`Updated ${antiConfigPath}`);

			// 2. Ensure Include line exists in main config
			let mainContent = '';
			try {
				mainContent = await fs.readFile(mainConfigPath, 'utf-8');
			} catch (e) { /* ignore if doesn't exist */ }

			if (!mainContent.includes(INCLUDE_LINE)) {
				// Prepend to the top for maximum compatibility
				mainContent = `${INCLUDE_LINE}\n${mainContent}`;
				await fs.writeFile(mainConfigPath, mainContent, 'utf-8');
				log(`Added Include line to ${mainConfigPath}`);
			}
		} else {
			// 1. Remove Include line from main config
			try {
				let mainContent = await fs.readFile(mainConfigPath, 'utf-8');
				if (mainContent.includes(INCLUDE_LINE)) {
					// Simply remove the Include line (we're the only one who writes it)
					mainContent = mainContent.replace(`${INCLUDE_LINE}\n`, '');
					mainContent = mainContent.replace(INCLUDE_LINE, ''); // fallback if no trailing newline
					await fs.writeFile(mainConfigPath, mainContent, 'utf-8');
					log(`Removed Include line from ${mainConfigPath}`);
				}
			} catch (e) { /* ignore */ }

			// 2. Delete the config.antigravity file
			try {
				await fs.unlink(antiConfigPath);
				log(`Deleted ${antiConfigPath}`);
			} catch (e) { /* ignore if already gone */ }
		}

		log(`SSH config updated (enable=${enable})`);
	} catch (error) {
		log(`SSH config update error: ${error}`);
		throw error;
	}
}

/**
 * Check if the forwarding is enabled by looking at the Include line and the sub-config
 */
async function getSSHConfigStatus(): Promise<{ enabled: boolean; port?: number }> {
	try {
		const mainContent = await fs.readFile(getSSHConfigPath(), 'utf-8');
		if (mainContent.includes(INCLUDE_LINE)) {
			const antiContent = await fs.readFile(getAntigravityConfigPath(), 'utf-8');
			const match = antiContent.match(/RemoteForward\s+(\d+)\s+(?:localhost|127\.0\.0\.1):/);
			if (match) {
				return { enabled: true, port: parseInt(match[1]) };
			}
		}
	} catch {
		// Files don't exist
	}
	return { enabled: false };
}

export function activate(context: vscode.ExtensionContext) {
	// 创建专用的 Output Channel
	outputChannel = vscode.window.createOutputChannel('Antigravity SSH Proxy');
	context.subscriptions.push(outputChannel);

	log(`Activating... isLocal=${isRunningLocally()}`);

	// 初始化状态管理器
	statusManager = new StatusManager(isRunningLocally(), context);
	context.subscriptions.push(statusManager);

	// 初始化诊断面板
	diagnosticPanel = new DiagnosticPanel(context);
	context.subscriptions.push({ dispose: () => diagnosticPanel.dispose() });

	// 初始化流量面板
	trafficPanel = new TrafficPanel(context);
	context.subscriptions.push({ dispose: () => trafficPanel.dispose() });

	// 注册显示输出窗口的命令
	context.subscriptions.push(
		vscode.commands.registerCommand('antigravity-ssh-proxy.showOutput', () => {
			outputChannel.show();
		})
	);

	// 注册显示状态面板的命令
	context.subscriptions.push(
		vscode.commands.registerCommand('antigravity-ssh-proxy.showStatusPanel', () => {
			statusManager.showStatusPanel();
		})
	);

	// 注册刷新状态的命令
	context.subscriptions.push(
		vscode.commands.registerCommand('antigravity-ssh-proxy.refreshStatus', async () => {
			await statusManager.refreshStatus();
		})
	);

	// 注册诊断命令
	context.subscriptions.push(
		vscode.commands.registerCommand('antigravity-ssh-proxy.diagnose', async () => {
			await diagnosticPanel.show();
		})
	);

	// 注册流量监控命令
	context.subscriptions.push(
		vscode.commands.registerCommand('antigravity-ssh-proxy.showTrafficPanel', () => {
			trafficPanel.show();
		})
	);

	// 启动自动刷新状态
	statusManager.startAutoRefresh();

	if (isRunningLocally()) {
		activateLocal(context).catch(err => log(`activateLocal error: ${err}`));
	} else {
		activateRemote(context).catch(err => log(`activateRemote error: ${err}`));
	}
}

async function activateLocal(context: vscode.ExtensionContext) {
	// 设置配置变更回调（用于面板中修改配置时触发）
	statusManager.setConfigChangeCallback(async () => {
		const cfg = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
		const lp = cfg.get<number>('localProxyPort', 7890);
		const rp = cfg.get<number>('remoteProxyPort', 7890);
		const enabled = cfg.get<boolean>('enableLocalForwarding', true);
		await updateSSHConfigFile(rp, lp, enabled, getRemoteCodexProfileBridgePort(rp));
		statusManager.updateSSHConfigStatus(enabled, rp);
	});

	const config = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
	const enable = config.get<boolean>('enableLocalForwarding', true);
	const localPort = config.get<number>('localProxyPort', 7890);
	const remotePort = config.get<number>('remoteProxyPort', 7890);
	const codexBridgeRemotePort = getRemoteCodexProfileBridgePort(remotePort);

	log(`Config: enable=${enable}, localPort=${localPort}, remotePort=${remotePort}, codexBridgeRemotePort=${codexBridgeRemotePort}`);

	codexProfileBridgeServer = new CodexProfileBridgeServer();
	try {
		const bridgeResult = await codexProfileBridgeServer.start();
		log(
			bridgeResult.reusedExisting
				? `Codex profile bridge already running on 127.0.0.1:${LOCAL_CODEX_PROFILE_BRIDGE_PORT}`
				: `Codex profile bridge listening on 127.0.0.1:${LOCAL_CODEX_PROFILE_BRIDGE_PORT}`
		);
	} catch (error) {
		log(`Failed to start Codex profile bridge: ${error}`);
		vscode.window.showWarningMessage(
			`ATP could not start the local Codex profile bridge on 127.0.0.1:${LOCAL_CODEX_PROFILE_BRIDGE_PORT}. Codex profile sync may be unavailable until this port is free.`
		);
	}

	// Auto-setup on activation
	if (enable) {
		await updateSSHConfigFile(remotePort, localPort, true, codexBridgeRemotePort);
		statusManager.updateSSHConfigStatus(true, remotePort);
		if (!await checkPortAvailable('127.0.0.1', localPort)) {
			vscode.window.showWarningMessage(
				`Local proxy at 127.0.0.1:${localPort} is not running. ` +
				`Also check if port ${remotePort} is occupied on the remote server before reconnecting.`
			);
		}
	}

	// 初始刷新状态
	await statusManager.refreshStatus();

	// 同步初始 SSH 配置状态
	const initialStatus = await getSSHConfigStatus();
	statusManager.updateSSHConfigStatus(initialStatus.enabled, initialStatus.port);

	// Watch config changes (from VS Code settings)
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(async (e: vscode.ConfigurationChangeEvent) => {
			if (e.affectsConfiguration('antigravity-ssh-proxy')) {
				const cfg = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
				const lp = cfg.get<number>('localProxyPort', 7890);
				const rp = cfg.get<number>('remoteProxyPort', 7890);
				const enabled = cfg.get<boolean>('enableLocalForwarding', true);
				await updateSSHConfigFile(rp, lp, enabled, getRemoteCodexProfileBridgePort(rp));
				statusManager.updateSSHConfigStatus(enabled, rp);
				await statusManager.refreshStatus();
			}
		})
	);

	// Commands
	context.subscriptions.push(
		vscode.commands.registerCommand('antigravity-ssh-proxy.enableForwarding', async () => {
			const cfg = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
			const lp = cfg.get<number>('localProxyPort', 7890);
			const rp = cfg.get<number>('remoteProxyPort', 7890);
			await updateSSHConfigFile(rp, lp, true, getRemoteCodexProfileBridgePort(rp));
			statusManager.updateSSHConfigStatus(true, rp);
			await statusManager.refreshStatus();
			vscode.window.showInformationMessage('SSH port forwarding enabled');
		}),

		vscode.commands.registerCommand('antigravity-ssh-proxy.disableForwarding', async () => {
			await updateSSHConfigFile(0, 0, false, 0);
			statusManager.updateSSHConfigStatus(false);
			await statusManager.refreshStatus();
			vscode.window.showInformationMessage('SSH port forwarding disabled');
		}),

		vscode.commands.registerCommand('antigravity-ssh-proxy.tunnelStatus', async () => {
			const status = await getSSHConfigStatus();
			statusManager.updateSSHConfigStatus(status.enabled, status.port);
			vscode.window.showInformationMessage(
				status.enabled
					? `Forwarding configured on port: ${status.port}`
					: 'SSH port forwarding is not configured'
			);
		})
	);
}

/**
 * Ensure mgraftcp binary has execute permission
 */
async function ensureMgraftcpExecutable(extensionPath: string): Promise<void> {
	const arch = os.arch();
	let binaryName: string;

	switch (arch) {
		case 'x64':
		case 'amd64':
			binaryName = 'mgraftcp-fakedns-linux-amd64';
			break;
		case 'arm64':
		case 'aarch64':
			binaryName = 'mgraftcp-fakedns-linux-arm64';
			break;
		default:
			log(`Unsupported architecture: ${arch}`);
			return;
	}

	const mgraftcpPath = path.join(extensionPath, 'resources', 'bin', binaryName);

	try {
		await execAsync(`chmod +x "${mgraftcpPath}"`);
		log(`Set execute permission for ${mgraftcpPath}`);
	} catch (error) {
		log(`Failed to set execute permission for mgraftcp: ${error}`);
	}
}

async function readExtensionVersion(extensionPath: string): Promise<string> {
	try {
		const packageJsonPath = path.join(extensionPath, 'package.json');
		const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
		const packageJson = JSON.parse(packageJsonContent);
		return packageJson.version || 'unknown';
	} catch (error) {
		log(`Failed to read package.json: ${error}`);
		return 'unknown';
	}
}

async function activateRemote(context: vscode.ExtensionContext) {
	const config = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
	// Remote only cares about remoteProxyHost, remoteProxyPort, and proxyType
	const remoteHost = config.get<string>('remoteProxyHost', '127.0.0.1');
	const remotePort = config.get<number>('remoteProxyPort', 7890);
	const proxyType = config.get<string>('proxyType', 'http');
	const targetApps = getConfiguredTargetApps(config);

	if (process.platform !== 'linux') {
		log(`Skipping setup: unsupported platform '${process.platform}' (only Linux is supported)`);
		return;
	}

	// Use extensionUri.fsPath for correct remote path resolution
	const extensionPath = context.extensionUri.fsPath;
	const extensionVersion = await readExtensionVersion(extensionPath);

	// Ensure mgraftcp binary has execute permission before setup
	await ensureMgraftcpExecutable(extensionPath);

	// 设置配置变更回调（用于面板中修改配置时触发）
	statusManager.setConfigChangeCallback(async () => {
		const cfg = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
		const host = cfg.get<string>('remoteProxyHost', '127.0.0.1');
		const port = cfg.get<number>('remoteProxyPort', 7890);
		const type = cfg.get<string>('proxyType', 'http');
		const apps = getConfiguredTargetApps(cfg);
		log(`Config changed from panel, re-running setup: ${host}:${port} (${type}) targets=${formatTargetAppsEnv(apps)}`);
		const success = await runSetupScriptSilently(host, port, type, extensionPath, extensionVersion, apps);
		statusManager.updateLanguageServerStatus(success);
	});

	log(`Remote Proxy: ${remoteHost}:${remotePort} (${proxyType})`);
	log(`Managed targets: ${formatTargetAppsEnv(targetApps)}`);

	// 初始刷新状态
	await statusManager.refreshStatus();

	// Auto-run setup script
	log(`Extension path: ${extensionPath}`);
	log('Auto-running setup script...');
	const setupSuccess = await runSetupScriptSilently(remoteHost, remotePort, proxyType, extensionPath, extensionVersion, targetApps);
	statusManager.updateLanguageServerStatus(setupSuccess);

	// Watch config changes (from VS Code settings)
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(async (e: vscode.ConfigurationChangeEvent) => {
			if (e.affectsConfiguration('antigravity-ssh-proxy.remoteProxyHost') ||
				e.affectsConfiguration('antigravity-ssh-proxy.remoteProxyPort') ||
				e.affectsConfiguration('antigravity-ssh-proxy.proxyType') ||
				e.affectsConfiguration('antigravity-ssh-proxy.targetApps')) {
				const cfg = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
				const host = cfg.get<string>('remoteProxyHost', '127.0.0.1');
				const port = cfg.get<number>('remoteProxyPort', 7890);
				const type = cfg.get<string>('proxyType', 'http');
				const apps = getConfiguredTargetApps(cfg);
				log(`Config changed, re-running setup: ${host}:${port} (${type}) targets=${formatTargetAppsEnv(apps)}`);
				const success = await runSetupScriptSilently(host, port, type, extensionPath, extensionVersion, apps);
				statusManager.updateLanguageServerStatus(success);
				await statusManager.refreshStatus();
			}
		})
	);

	// Remote commands
	context.subscriptions.push(
		vscode.commands.registerCommand('antigravity-ssh-proxy.syncCodexProfile', async () => {
			try {
				log('Starting Codex profile sync via local bridge');
				const snapshot = await fetchCodexProfileSnapshotFromBridge(remoteHost, remotePort);

				if (!snapshot) {
					vscode.window.showErrorMessage(
						'ATP could not read the local Codex profile from the bridge.'
					);
					return;
				}

				const result = await applyCodexProfileSnapshot(snapshot);
				log(`Codex profile synced. provider=${snapshot.modelProvider ?? 'unknown'} backup=${result.backupDir}`);
				promptReloadWindow(
					`Codex profile synced from your local machine${snapshot.modelProvider ? ` (${snapshot.modelProvider})` : ''}. Reload the remote window to refresh ChatGPT/Codex authentication.`
				);
				vscode.window.showInformationMessage(
					`Codex profile synced. Backup saved at ${result.backupDir}`
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log(`Codex profile sync failed: ${message}`);
				vscode.window.showErrorMessage(
					`Codex profile sync failed: ${message}. If you just updated ATP locally, reconnect the SSH remote window so the new bridge port forward can take effect.`
				);
			}
		}),

		vscode.commands.registerCommand('antigravity-ssh-proxy.restoreCodexProfile', async () => {
			try {
				const result = await restoreLatestCodexProfileBackup();
				log(`Codex profile restored from ${result.backupDir}`);
				promptReloadWindow(
					`Remote Codex profile restored${result.modelProvider ? ` (${result.modelProvider})` : ''}. Reload the remote window to refresh ChatGPT/Codex authentication.`
				);
				vscode.window.showInformationMessage(
					`Remote Codex profile restored from ${result.backupDir}`
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log(`Codex profile restore failed: ${message}`);
				vscode.window.showErrorMessage(`Codex profile restore failed: ${message}`);
			}
		}),

		vscode.commands.registerCommand('antigravity-ssh-proxy.rebucketCodexHistory', async () => {
			try {
				const buckets = await getCodexHistoryBuckets();
				if (buckets.length === 0) {
					vscode.window.showWarningMessage(
						'ATP did not find any Codex history buckets under ~/.codex.'
					);
					return;
				}

				const sourceSelection = await vscode.window.showQuickPick(
					buckets.map(bucket => ({
						label: bucket.provider,
						description: `${bucket.rolloutCount} rollout(s), ${bucket.threadCount} thread row(s)`,
						bucket
					})),
					{
						title: 'Rebucket Codex History',
						placeHolder: 'Choose the source provider bucket to migrate from'
					}
				);

				if (!sourceSelection) {
					return;
				}

				const previewForDefault = await previewCodexHistoryRebucket(
					sourceSelection.bucket.provider,
					sourceSelection.bucket.provider
				);

				const targetProvider = await vscode.window.showInputBox({
					title: 'Rebucket Codex History',
					prompt: 'Enter the target provider bucket name',
					value: previewForDefault.currentProvider ?? sourceSelection.bucket.provider,
					ignoreFocusOut: true,
					validateInput: value => {
						if (!value.trim()) {
							return 'Provider name cannot be empty';
						}
						return undefined;
					}
				});

				if (!targetProvider) {
					return;
				}

				const normalizedTargetProvider = targetProvider.trim();
				if (normalizedTargetProvider === sourceSelection.bucket.provider) {
					vscode.window.showInformationMessage(
						'Source provider and target provider are the same. No history rebucketing is needed.'
					);
					return;
				}

				const preview = await previewCodexHistoryRebucket(
					sourceSelection.bucket.provider,
					normalizedTargetProvider
				);

				const proceed = await vscode.window.showWarningMessage(
					`This will rewrite ${preview.rolloutCount} rollout file(s) and ${preview.threadCount} thread row(s) from "${preview.sourceProvider}" to "${preview.targetProvider}". ATP will create a restorable backup first.`,
					{ modal: true },
					'Rebucket History'
				);

				if (proceed !== 'Rebucket History') {
					return;
				}

				const result = await rebucketCodexHistory(
					sourceSelection.bucket.provider,
					normalizedTargetProvider
				);

				log(`Codex history rebucketed from ${result.sourceProvider} to ${result.targetProvider}. backup=${result.backupDir}`);
				promptReloadWindow(
					`Codex history rebucketed from ${result.sourceProvider} to ${result.targetProvider}. Reload the remote window to refresh the history view.`
				);
				vscode.window.showInformationMessage(
					`Codex history rebucketed. Backup saved at ${result.backupDir}`
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log(`Codex history rebucket failed: ${message}`);
				vscode.window.showErrorMessage(`Codex history rebucket failed: ${message}`);
			}
		}),

		vscode.commands.registerCommand('antigravity-ssh-proxy.restoreCodexHistory', async () => {
			try {
				const result = await restoreLatestCodexHistoryBackup();
				log(`Codex history restored from ${result.backupDir}`);
				promptReloadWindow(
					`Codex history restored${result.sourceProvider && result.targetProvider ? ` (${result.targetProvider} -> ${result.sourceProvider})` : ''}. Reload the remote window to refresh the history view.`
				);
				vscode.window.showInformationMessage(
					`Codex history restored from ${result.backupDir}`
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log(`Codex history restore failed: ${message}`);
				vscode.window.showErrorMessage(`Codex history restore failed: ${message}`);
			}
		}),

		vscode.commands.registerCommand('antigravity-ssh-proxy.setup', () => {
			const cfg = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
			const type = cfg.get<string>('proxyType', 'http');
			const apps = getConfiguredTargetApps(cfg);
			const terminal = vscode.window.createTerminal('Antigravity Setup');
			terminal.show();
			const script = generateSetupScript(remoteHost, remotePort, type, extensionPath, apps, extensionVersion);
			terminal.sendText(`cat > /tmp/ag_setup.sh << 'EOF'\n${script}\nEOF`);
			terminal.sendText('bash /tmp/ag_setup.sh');
		}),

		vscode.commands.registerCommand('antigravity-ssh-proxy.rollback', () => {
			const terminal = vscode.window.createTerminal('Antigravity Rollback');
			terminal.show();
			terminal.sendText(generateRollbackScript());
			statusManager.updateLanguageServerStatus(false);
		}),

		vscode.commands.registerCommand('antigravity-ssh-proxy.checkProxy', async () => {
			const ok = await checkPortAvailable(remoteHost, remotePort);
			await statusManager.refreshStatus();
			vscode.window.showInformationMessage(ok ? `Proxy OK` : `Proxy NOT reachable`);
		})
	);

	// Show startup status notification if enabled
	const showStatusOnStartup = config.get<boolean>('showStatusOnStartup', true);
	if (showStatusOnStartup) {
		// Delay slightly to let setup complete
		setTimeout(async () => {
			await showStartupStatus(remoteHost, remotePort);
		}, 2000);
	}
}

/**
 * Show detailed warning when proxy is not reachable on the remote side.
 * Covers three possible causes: SSH tunnel not established, port mismatch, local proxy not running.
 */
async function showSSHTunnelNotEstablishedWarning(proxyHost: string, proxyPort: number): Promise<void> {
	const detailMessage =
		`Proxy not reachable at ${proxyHost}:${proxyPort}\n\n` +
		`This can happen for several reasons. Please check each one:\n\n` +
		`─── Cause 1: SSH tunnel not established ───\n` +
		`You may have connected directly via Antigravity's "Recent Connections"\n` +
		`without opening a local window first.\n` +
		`Fix:\n` +
		`  1. Close this remote connection\n` +
		`  2. Open a new local window (File > New Window)\n` +
		`  3. Connect to the remote server from the local window\n\n` +
		`─── Cause 2: Port mismatch ───\n` +
		`The "Remote Port" in the Local ATP panel must equal\n` +
		`the "Proxy Port" in the Remote ATP panel.\n` +
		`Fix:\n` +
		`  1. Open the ATP panel (click the status bar item)\n` +
		`  2. In the Local window: note the "Remote Port" value\n` +
		`  3. In the Remote window: set "Proxy Port" to the same value\n` +
		`  4. Save and reconnect\n\n` +
		`─── Cause 3: Local proxy software not running ───\n` +
		`The local proxy (e.g., Clash, V2Ray) may not be started,\n` +
		`or its port does not match the "Local Port" in the ATP panel.\n` +
		`Fix:\n` +
		`  1. Start your local proxy software\n` +
		`  2. Open the ATP panel and confirm "Local Port" matches your proxy's port\n` +
		`  3. Save and reconnect`;

	log('Showing proxy not reachable warning dialog');

	const selection = await vscode.window.showWarningMessage(
		detailMessage,
		{ modal: true },
		'Open ATP Panel',
		'Run Diagnostics',
		'Close Remote Connection',
		'Dismiss'
	);

	if (selection === 'Open ATP Panel') {
		vscode.commands.executeCommand('antigravity-ssh-proxy.showStatusPanel');
	} else if (selection === 'Run Diagnostics') {
		vscode.commands.executeCommand('antigravity-ssh-proxy.diagnose');
	} else if (selection === 'Close Remote Connection') {
		vscode.window.showInformationMessage(
			'After closing: 1) Open a new local window  2) Connect to remote from there',
			'Got it'
		).then(() => {
			vscode.commands.executeCommand('workbench.action.remote.close');
		});
	}
}

/**
 * Show startup status notification with detailed diagnostics in output channel
 */
async function showStartupStatus(proxyHost: string, proxyPort: number): Promise<void> {
	try {
		log('');
		log('========== Startup Status Check ==========');
		log(`Proxy endpoint: ${proxyHost}:${proxyPort}`);
		log('');

		// Test 1: Port connectivity
		log(`[Test 1] Checking port connectivity...`);
		log(`  Command: nc -zv ${proxyHost} ${proxyPort}`);
		const proxyReachable = await checkPortAvailable(proxyHost, proxyPort);
		log(`  Result: ${proxyReachable ? '✓ Port is reachable' : '✗ Port is NOT reachable'}`);
		log('');

		// Test 2: mgraftcp process
		log(`[Test 2] Checking if mgraftcp is running...`);
		log(`  Command: pgrep -f mgraftcp`);
		const proxyActive = await isMgraftcpRunning();
		log(`  Result: ${proxyActive ? '✓ mgraftcp is running (proxy active)' : '✗ mgraftcp is NOT running'}`);
		log('');

		// Test 2.5: Language Server process status (always check for diagnostic purposes)
		log(`[Test 2.5] Checking Language Server process status...`);
		const lsProcess = await getLanguageServerProcess();
		if (lsProcess) {
			const modeLabel = lsProcess.isPersistent ? 'persistent mode' : 'normal mode';
			const proxyLabel = lsProcess.isUsingProxy ? 'using proxy' : 'NOT using proxy';
			const statusIcon = lsProcess.isUsingProxy ? '✓' : (lsProcess.isPersistent ? '✗' : '⚠');
			log(`  Result: ${statusIcon} Language Server (PID ${lsProcess.pid}) is running in ${modeLabel}, ${proxyLabel}`);
			
			if (lsProcess.isPersistent && !lsProcess.isUsingProxy) {
				log(`  ⚠️ WARNING: LS is in persistent_mode but not using proxy!`);
				log(`    This is the bug scenario where LS was started before wrapper was configured.`);
				log(`    Will auto-fix by killing LS process...`);
			}
		} else {
			log(`  Result: ○ Language Server is not running (will start on demand)`);
		}
		log('');

		// Test 3: External connectivity (only if port is reachable)
		if (proxyReachable) {
			const config = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
			const currentProxyType = config.get<string>('proxyType', 'http');

			// Test HTTP proxy
			log(`[Test 3] Testing HTTP proxy connectivity...`);
			const httpCmd = `curl -x http://${proxyHost}:${proxyPort} https://www.google.com -s -o /dev/null -w "%{http_code}" --connect-timeout 10`;
			log(`  Command: ${httpCmd}`);
			let httpOk = false;
			try {
				const { stdout } = await execAsync(httpCmd, { timeout: 15000 });
				const httpCode = stdout.trim();
				httpOk = httpCode === '200' || httpCode === '301' || httpCode === '302';
				const marker = currentProxyType === 'http' ? ' ← Current' : '';
				log(`  Result: HTTP ${httpCode} ${httpOk ? '✓ OK' : '✗ Failed'}${marker}`);
			} catch (error) {
				const marker = currentProxyType === 'http' ? ' ← Current (⚠️ NOT WORKING)' : '';
				log(`  Result: ✗ Failed${marker}`);
			}
			log('');

			// Test SOCKS5 proxy
			log(`[Test 4] Testing SOCKS5 proxy connectivity...`);
			const socks5Cmd = `curl -x socks5://${proxyHost}:${proxyPort} https://www.google.com -s -o /dev/null -w "%{http_code}" --connect-timeout 10`;
			log(`  Command: ${socks5Cmd}`);
			let socks5Ok = false;
			try {
				const { stdout } = await execAsync(socks5Cmd, { timeout: 15000 });
				const httpCode = stdout.trim();
				socks5Ok = httpCode === '200' || httpCode === '301' || httpCode === '302';
				const marker = currentProxyType === 'socks5' ? ' ← Current' : '';
				log(`  Result: HTTP ${httpCode} ${socks5Ok ? '✓ OK' : '✗ Failed'}${marker}`);
			} catch (error) {
				const marker = currentProxyType === 'socks5' ? ' ← Current (⚠️ NOT WORKING)' : '';
				log(`  Result: ✗ Failed${marker}`);
			}
			log('');

			// Test SOCKS5H proxy (SOCKS5 with remote DNS resolution)
			log(`[Test 5] Testing SOCKS5H proxy connectivity (remote DNS)...`);
			const socks5hCmd = `curl -x socks5h://${proxyHost}:${proxyPort} https://www.google.com -s -o /dev/null -w "%{http_code}" --connect-timeout 10`;
			log(`  Command: ${socks5hCmd}`);
			try {
				const { stdout } = await execAsync(socks5hCmd, { timeout: 15000 });
				const httpCode = stdout.trim();
				const socks5hOk = httpCode === '200' || httpCode === '301' || httpCode === '302';
				log(`  Result: HTTP ${httpCode} ${socks5hOk ? '✓ OK' : '✗ Failed'}`);
			} catch (error) {
				log(`  Result: ✗ Failed`);
			}
			log('');
		}

		log('==========================================');
		log('');

		let message: string;
		let actions: string[] = [];

		// Check LS process status - this is the authoritative check for whether proxy is actually working
		// Note: proxyActive (isMgraftcpRunning) might be true due to stale processes,
		// but lsProcess.isUsingProxy tells us if the CURRENT LS is actually using proxy
		const lsProcessForDecision = await getLanguageServerProcess();
		const lsActuallyUsingProxy = lsProcessForDecision?.isUsingProxy ?? false;
		const lsIsPersistent = lsProcessForDecision?.isPersistent ?? false;
		const lsNeedsRestart = lsProcessForDecision && lsIsPersistent && !lsActuallyUsingProxy;

		if (proxyReachable && lsActuallyUsingProxy) {
			// Everything is actually working - LS is using proxy
			message = `✅ Proxy active (${proxyHost}:${proxyPort})`;
		} else if (proxyReachable && lsNeedsRestart) {
			// LS is in persistent mode but not using proxy - this is the bug scenario
			// Auto-fix by killing LS
			log('Startup: Detected persistent_mode LS not using proxy, auto-fixing...');
			
			const killed = await killLanguageServer();
			if (killed) {
				message = `🔄 Language Server restarted to enable proxy. Reloading...`;
				actions = ['Reload Now'];
				
				// Auto-reload after a short delay
				setTimeout(() => {
					vscode.commands.executeCommand('workbench.action.reloadWindow');
				}, 2000);
			} else {
				message = `⚠️ Proxy configured but Language Server needs manual restart.`;
				actions = ['Kill & Reload', 'Dismiss'];
			}
		} else if (proxyReachable && !proxyActive) {
			// Proxy is reachable, mgraftcp not running, LS might not be started yet or needs reload
			if (lsProcessForDecision && !lsActuallyUsingProxy) {
				// LS is running but not using proxy (non-persistent mode)
				message = `⚠️ Proxy configured but not active. Reload to enable.`;
				actions = ['Reload Now', 'Dismiss'];
			} else {
				// LS not running yet, or other state
				message = `⚠️ Proxy configured but not active. Reload to enable.`;
				actions = ['Reload Now', 'Dismiss'];
			}
		} else if (!proxyReachable) {
			// Proxy not reachable - likely SSH tunnel not established
			// This can happen when user directly connects to remote via Antigravity's memory feature
			log('Proxy not reachable - SSH tunnel may not be established');
			log('This can happen when connecting directly to remote without opening a local window first');

			// Show a detailed warning with explanation
			await showSSHTunnelNotEstablishedWarning(proxyHost, proxyPort);
			return;
		} else {
			message = `⚠️ Proxy status unknown`;
			actions = ['Run Diagnostics', 'Dismiss'];
		}

		log(`Startup status: ${message}`);

		if (actions.length > 0) {
			const selection = await vscode.window.showInformationMessage(message, ...actions);
			if (selection === 'Reload Now') {
				vscode.commands.executeCommand('workbench.action.reloadWindow');
			} else if (selection === 'Kill & Reload') {
				// Kill LS and reload
				await killLanguageServer();
				setTimeout(() => {
					vscode.commands.executeCommand('workbench.action.reloadWindow');
				}, 1000);
			} else if (selection === 'Run Diagnostics') {
				vscode.commands.executeCommand('antigravity-ssh-proxy.diagnose');
			} else if (selection === 'Close Remote') {
				// Close remote connection and return to local window
				vscode.commands.executeCommand('workbench.action.remote.close');
			}
		} else {
			// Just show a brief notification for success
			vscode.window.showInformationMessage(message);
		}
	} catch (error) {
		log(`Startup status check failed: ${error}`);
	}
}

/**
 * Run setup script silently in background (idempotent)
 * @returns true if setup was successful or already configured
 */
async function runSetupScriptSilently(
	proxyHost: string,
	proxyPort: number,
	proxyType: string,
	extensionPath: string,
	extensionVersion: string,
	targetApps: readonly string[]
): Promise<boolean> {
	const scriptPath = path.join(extensionPath, 'scripts', 'setup-proxy.sh');

	try {
		// Ensure script is executable
		await execAsync(`chmod +x "${scriptPath}"`);

		// Execute script directly with environment variables for proxy config
		const env = {
			...process.env,
			PROXY_HOST: proxyHost,
			PROXY_PORT: String(proxyPort),
			PROXY_TYPE: proxyType,
			EXTENSION_PATH: extensionPath,  // Current extension's exact path
			EXTENSION_VERSION: extensionVersion,  // Extension version for update detection
			TARGET_APPS: targetApps.join(',')
		};

		const { stdout, stderr } = await execAsync(`bash "${scriptPath}" 2>&1`, { env });
		const output = stdout || stderr || '';

		log(`Setup output: ${output}`);

		// Check if this is a new configuration
		const isNewConfig = output.includes('Setup complete') ||
			(output.includes('configured') && !output.includes('Already configured'));

		if (isNewConfig) {
			// New configuration or version update - need to restart LS
			log('Setup: New configuration applied');
			
			// Check if LS is in persistent mode - if so, need to kill it first
			// Otherwise the new wrapper won't take effect even after reload
			const lsProcess = await getLanguageServerProcess();
			if (lsProcess && lsProcess.isPersistent) {
				log('Setup: LS is in persistent_mode, killing to apply new configuration');
				const killed = await killLanguageServer();
				if (killed) {
					promptReloadWindow(
						'ATP proxy updated. Managed tools were refreshed. Please reload the window to reconnect.'
					);
				} else {
					vscode.window.showWarningMessage(
						'Proxy updated but a managed tool still needs restart. ' +
						'Run in terminal: kill $(pgrep -f language_server_linux) && then reload window.',
						'Reload Now'
					).then(selection => {
						if (selection === 'Reload Now') {
							vscode.commands.executeCommand('workbench.action.reloadWindow');
						}
					});
				}
			} else {
				// Non-persistent mode or LS not running - regular reload is fine
				promptReloadWindow(
					'ATP proxy configured. Reload window to apply changes to managed tools.'
				);
			}
			return true;
		} else if (output.includes('Already configured')) {
			log('Setup: Already configured');

			// Check if Language Server is actually using the proxy
			// Use getLanguageServerProcess() as the authoritative check, not just isMgraftcpRunning()
			// because there might be stale mgraftcp processes
			const lsProcess = await getLanguageServerProcess();
			const lsActuallyUsingProxy = lsProcess?.isUsingProxy ?? false;
			const lsIsPersistent = lsProcess?.isPersistent ?? false;
			
			if (lsProcess && !lsActuallyUsingProxy) {
				// Wrapper is configured but LS isn't using proxy (started before wrapper was set up)
				log('Setup: Proxy configured but LS not using it');
				
				if (lsIsPersistent) {
					// Persistent mode: LS won't restart on reload, need to kill it first
					log('Setup: Language Server is in persistent_mode, killing process to force restart through wrapper');
					
					const killed = await killLanguageServer();
					if (killed) {
						promptReloadWindow(
							'A managed tool was restarted to enable proxy. Please reload the window to reconnect.'
						);
					} else {
						// Fallback to manual instructions
						vscode.window.showWarningMessage(
							'Proxy configured but a managed tool still needs restart. ' +
							'Run in terminal: kill $(pgrep -f language_server_linux) && then reload window.',
							'Reload Now'
						).then(selection => {
							if (selection === 'Reload Now') {
								vscode.commands.executeCommand('workbench.action.reloadWindow');
							}
						});
					}
				} else {
					// Non-persistent mode: regular reload should work
					log('Setup: Prompting reload');
					promptReloadWindow(
						'Proxy is configured but not active. Reload window to enable proxy for managed tools.'
					);
				}
			} else if (lsActuallyUsingProxy) {
				log('Setup: Proxy is active, no reload needed');
			} else {
				// LS not running yet - this is fine, it will start with proxy when needed
				log('Setup: LS not running, will use proxy when started');
			}
			return true;
		}
		return false;
	} catch (error: unknown) {
		const err = error as { message?: string; stdout?: string; stderr?: string };
		log(`Setup error: ${err.message || error}`);
		if (err.stdout) { log(`stdout: ${err.stdout}`); }
		if (err.stderr) { log(`stderr: ${err.stderr}`); }
		return false;
	}
}

export async function deactivate() {
	if (statusManager) {
		statusManager.stopAutoRefresh();
	}
	if (isRunningLocally()) {
		try {
			await updateSSHConfigFile(0, 0, false, 0);
		} catch (e) {
			log(`Cleanup during deactivation failed: ${e}`);
		}
		if (codexProfileBridgeServer) {
			try {
				await codexProfileBridgeServer.stop();
			} catch (error) {
				log(`Failed to stop Codex profile bridge: ${error}`);
			}
		}
	}
}
