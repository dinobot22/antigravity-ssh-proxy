import * as vscode from 'vscode';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { watch as fsWatch, FSWatcher } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { generateSetupScript, generateRollbackScript } from './remoteSetup';
import { StatusManager } from './statusManager';
import { DiagnosticPanel } from './diagnostics/diagnosticPanel';
import { TrafficPanel } from './traffic/trafficPanel';

const execAsync = promisify(exec);

let outputChannel: vscode.OutputChannel;
let statusManager: StatusManager;
let diagnosticPanel: DiagnosticPanel;
let trafficPanel: TrafficPanel;

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
		const { stdout } = await execAsync("pgrep -f '[m]graftcp'");
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
 * 1. mgraftcp process (parent, contains binary name as argument)
 * 2. actual language_server or agy process (child, the .bak binary)
 * 
 * We need to find the actual LS process and determine if it was started via mgraftcp
 */
async function getLanguageServerProcess(): Promise<{ pid: number; isPersistent: boolean; isUsingProxy: boolean; isProxied: boolean } | null> {
	try {
		const { stdout } = await execAsync("ps aux | grep -E '(language_server_linux|\\.gemini/bin/agy(\\.bak)?\\s+--hub)' | grep -v grep");
		const lines = stdout.trim().split('\n').filter(l => l.length > 0);
		
		// First pass: check if mgraftcp is wrapping the LS (indicates proxy is active)
		const hasMgraftcpWrapper = lines.some(line => line.includes('mgraftcp'));
		
		// Prioritize v2.6.0+ (.gemini/bin/agy) over legacy language_server_linux if both exist
		const sortedLines = [...lines].sort((a, b) => {
			const aIsAgy = a.includes('.gemini/bin/agy') ? 0 : 1;
			const bIsAgy = b.includes('.gemini/bin/agy') ? 0 : 1;
			return aIsAgy - bIsAgy;
		});

		// Second pass: find the actual LS/agy process (not the mgraftcp line)
		for (const line of sortedLines) {
			// Skip the mgraftcp wrapper line, we want the actual binary
			if (line.includes('mgraftcp-fakedns')) {
				continue;
			}
			
			// Look for the actual language_server or agy hub process (either direct or .bak)
			const isAgy = line.includes('.gemini/bin/agy') && line.includes('--hub');
			const isLegacy = line.includes('language_server_linux');

			if (isAgy || isLegacy) {
				const parts = line.split(/\s+/);
				if (parts.length >= 2) {
					const pid = parseInt(parts[1]);
					const isPersistent = isAgy || line.includes('--persistent_mode') || line.includes('persistent_mode');
					const isProxied = line.includes('.bak') || line.includes('mgraftcp') || hasMgraftcpWrapper;
					
					if (!isNaN(pid)) {
						return { 
							pid, 
							isPersistent, 
							isUsingProxy: isProxied,
							isProxied
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
async function killLanguageServer(targetPid?: number): Promise<boolean> {
	const lsProcess = await getLanguageServerProcess();
	if (!lsProcess && targetPid === undefined) {
		log('No Language Server process found to kill');
		return false;
	}
	const pidToKill = targetPid ?? lsProcess!.pid;
	
	try {
		log(`Killing Language Server process (PID: ${pidToKill}, persistent: ${lsProcess?.isPersistent ?? true})`);
		await execAsync(`kill ${pidToKill}`).catch(() => {});
		await execAsync("pkill -f '[l]anguage_server_linux'").catch(() => {});
		await execAsync("pkill -f '[.]gemini/bin/agy(\\.bak)?.*--hub'").catch(() => {});
		
		// Wait briefly for process to terminate on SIGTERM
		await new Promise(resolve => setTimeout(resolve, 700));
		
		// Only SIGKILL if the original target PID is still alive (avoid killing a newly respawned agy process)
		let originalStillAlive = false;
		try {
			process.kill(pidToKill, 0);
			originalStillAlive = true;
		} catch {
			originalStillAlive = false;
		}
		if (originalStillAlive) {
			log(`Process ${pidToKill} still running after SIGTERM, using SIGKILL`);
			await execAsync(`kill -9 ${pidToKill}`).catch(() => {});
			await execAsync("pkill -9 -f '[l]anguage_server_linux'").catch(() => {});
		}
		
		log('Language Server process killed successfully');
		return true;
	} catch (error) {
		log(`Failed to kill Language Server: ${error}`);
		return false;
	}
}

/**
 * Poll for Language Server / agy process to come back up using the proxy wrapper
 * (Antigravity IDE v2.6.0+ auto-recovery respawns agy after ~0.8-1.2s backoff)
 */
async function waitForProxiedLanguageServer(
	timeoutMs: number = 3500,
	excludePid?: number
): Promise<{ pid: number; isPersistent: boolean; isUsingProxy: boolean; isProxied: boolean } | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const proc = await getLanguageServerProcess();
		if (proc && proc.isUsingProxy && (excludePid === undefined || proc.pid !== excludePid)) {
			return proc;
		}
		await new Promise(resolve => setTimeout(resolve, 400));
	}
	return await getLanguageServerProcess();
}

const AGY_INSTALL_LOCK_STALE_MS = 15 * 60 * 1000;

function getGeminiBinDir(): string {
	return path.join(os.homedir(), '.gemini', 'bin');
}

function getAgyBinaryPath(): string {
	return path.join(getGeminiBinDir(), 'agy');
}

function getAgyInstallLockPath(): string {
	return path.join(getGeminiBinDir(), '.agy-install.lock');
}

/**
 * Fast check (reads only the first 1KB) to determine whether ~/.gemini/bin/agy
 * is already our bash wrapper script rather than an raw ELF binary.
 */
async function isAgyWrapperConfigured(agyPath: string = getAgyBinaryPath()): Promise<boolean> {
	try {
		const handle = await fs.open(agyPath, 'r');
		try {
			const buffer = Buffer.alloc(1024);
			const { bytesRead } = await handle.read(buffer, 0, 1024, 0);
			const header = buffer.subarray(0, bytesRead).toString('utf-8');
			return header.includes('ANTIGRAVITY_SSH_PROXY_WRAPPER');
		} finally {
			await handle.close();
		}
	} catch {
		return false;
	}
}

/**
 * Check if Antigravity's built-in extension currently holds ~/.gemini/bin/.agy-install.lock
 */
async function isAgyInstallLockActive(): Promise<boolean> {
	const lockPath = getAgyInstallLockPath();
	try {
		const raw = await fs.readFile(lockPath, 'utf-8');
		const payload = JSON.parse(raw) as { pid?: number; hostname?: string; createdAt?: number };
		if (typeof payload.pid !== 'number' || typeof payload.createdAt !== 'number') {
			return false;
		}
		if (Math.abs(Date.now() - payload.createdAt) > AGY_INSTALL_LOCK_STALE_MS) {
			return false;
		}
		if (payload.hostname === os.hostname()) {
			try {
				process.kill(payload.pid, 0);
				return true;
			} catch (err: unknown) {
				return (err as { code?: string })?.code === 'EPERM';
			}
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Wait if ~/.gemini/bin/.agy-install.lock is currently held by an in-flight IDE backend update
 */
async function waitForAgyInstallLock(maxWaitMs: number = 30000): Promise<void> {
	if (!await isAgyInstallLockActive()) {
		return;
	}
	log('Detected active ~/.gemini/bin/.agy-install.lock (IDE is updating agy backend). Waiting for update to finish...');
	const deadline = Date.now() + maxWaitMs;
	while (Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, 500));
		if (!await isAgyInstallLockActive()) {
			// Give writeBinarySidecar (agy.version.json) a brief moment to finish after lock release
			await new Promise(resolve => setTimeout(resolve, 200));
			log('Antigravity backend install lock released, proceeding with proxy setup.');
			return;
		}
	}
	log('Timed out waiting for .agy-install.lock; proceeding and relying on agy.version.json watcher.');
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
async function updateSSHConfigFile(remotePort: number, localPort: number, enable: boolean): Promise<void> {
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
		await updateSSHConfigFile(rp, lp, enabled);
		statusManager.updateSSHConfigStatus(enabled, rp);
	});

	const config = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
	const enable = config.get<boolean>('enableLocalForwarding', true);
	const localPort = config.get<number>('localProxyPort', 7890);
	const remotePort = config.get<number>('remoteProxyPort', 7890);

	log(`Config: enable=${enable}, localPort=${localPort}, remotePort=${remotePort}`);

	// Auto-setup on activation
	if (enable) {
		await updateSSHConfigFile(remotePort, localPort, true);
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
				await updateSSHConfigFile(rp, lp, enabled);
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
			await updateSSHConfigFile(rp, lp, true);
			statusManager.updateSSHConfigStatus(true, rp);
			await statusManager.refreshStatus();
			vscode.window.showInformationMessage('SSH port forwarding enabled');
		}),

		vscode.commands.registerCommand('antigravity-ssh-proxy.disableForwarding', async () => {
			await updateSSHConfigFile(0, 0, false);
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

/**
 * Watch ~/.gemini/bin/agy.version.json for Antigravity IDE v2.6.0+ backend updates.
 * The built-in google-antigravity extension writes agy.version.json (via atomic tmp rename)
 * as the very last step after downloading, verifying, and replacing ~/.gemini/bin/agy.
 */
async function watchAgyVersionSidecar(context: vscode.ExtensionContext, extensionPath: string): Promise<void> {
	const geminiBinDir = getGeminiBinDir();
	const agyBinaryPath = getAgyBinaryPath();

	try {
		await fs.mkdir(geminiBinDir, { recursive: true });
	} catch {
		// Ignore directory creation errors
	}

	let debounceTimer: NodeJS.Timeout | undefined;
	const triggerCheck = (source: string) => {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
		}
		debounceTimer = setTimeout(async () => {
			debounceTimer = undefined;
			try {
				await waitForAgyInstallLock(15000);
				try {
					await fs.access(agyBinaryPath);
				} catch {
					return;
				}
				const alreadyWrapped = await isAgyWrapperConfigured(agyBinaryPath);
				if (alreadyWrapped) {
					return;
				}
				log(`[Watcher:${source}] Detected agy.version.json update with unwrapped ~/.gemini/bin/agy (IDE backend updated). Re-applying proxy wrapper...`);
				const cfg = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
				const host = cfg.get<string>('remoteProxyHost', '127.0.0.1');
				const port = cfg.get<number>('remoteProxyPort', 7890);
				const type = cfg.get<string>('proxyType', 'http');
				const success = await runSetupScriptSilently(host, port, type, extensionPath);
				statusManager.updateLanguageServerStatus(success);
				await statusManager.refreshStatus();
			} catch (err) {
				log(`[Watcher:${source}] Error handling agy.version.json update: ${err}`);
			}
		}, 400);
	};

	let fsWatcher: FSWatcher | undefined;
	try {
		fsWatcher = fsWatch(geminiBinDir, (_eventType, filename) => {
			if (filename && filename !== 'agy.version.json') {
				return;
			}
			triggerCheck('fs.watch');
		});
		log(`Watching ${geminiBinDir}/agy.version.json for Antigravity backend updates`);
	} catch (err) {
		log(`Failed to start fs.watch on ${geminiBinDir}: ${err}`);
	}

	const vscodeWatcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(vscode.Uri.file(geminiBinDir), 'agy.version.json')
	);
	vscodeWatcher.onDidCreate(() => triggerCheck('vscode.onDidCreate'));
	vscodeWatcher.onDidChange(() => triggerCheck('vscode.onDidChange'));

	context.subscriptions.push(
		vscodeWatcher,
		new vscode.Disposable(() => {
			if (debounceTimer) {
				clearTimeout(debounceTimer);
				debounceTimer = undefined;
			}
			if (fsWatcher) {
				fsWatcher.close();
				fsWatcher = undefined;
			}
		})
	);
}

async function activateRemote(context: vscode.ExtensionContext) {
	const config = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
	// Remote only cares about remoteProxyHost, remoteProxyPort, and proxyType
	const remoteHost = config.get<string>('remoteProxyHost', '127.0.0.1');
	const remotePort = config.get<number>('remoteProxyPort', 7890);
	const proxyType = config.get<string>('proxyType', 'http');

	if (process.platform !== 'linux') {
		log(`Skipping setup: unsupported platform '${process.platform}' (only Linux is supported)`);
		return;
	}

	// Use extensionUri.fsPath for correct remote path resolution
	const extensionPath = context.extensionUri.fsPath;

	// Ensure mgraftcp binary has execute permission before setup
	await ensureMgraftcpExecutable(extensionPath);

	// Start watching ~/.gemini/bin/agy.version.json before initial setup so no mid-startup update is missed
	await watchAgyVersionSidecar(context, extensionPath);

	// 设置配置变更回调（用于面板中修改配置时触发）
	statusManager.setConfigChangeCallback(async () => {
		const cfg = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
		const host = cfg.get<string>('remoteProxyHost', '127.0.0.1');
		const port = cfg.get<number>('remoteProxyPort', 7890);
		const type = cfg.get<string>('proxyType', 'http');
		log(`Config changed from panel, re-running setup: ${host}:${port} (${type})`);
		const success = await runSetupScriptSilently(host, port, type, extensionPath);
		statusManager.updateLanguageServerStatus(success);
	});

	log(`Remote Proxy: ${remoteHost}:${remotePort} (${proxyType})`);

	// 初始刷新状态
	await statusManager.refreshStatus();

	// If Antigravity's built-in extension is actively updating ~/.gemini/bin/agy right now, wait for it
	await waitForAgyInstallLock();

	// Auto-run setup script
	log(`Extension path: ${extensionPath}`);
	log('Auto-running setup script...');
	const setupSuccess = await runSetupScriptSilently(remoteHost, remotePort, proxyType, extensionPath);
	statusManager.updateLanguageServerStatus(setupSuccess);

	// Watch config changes (from VS Code settings)
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(async (e: vscode.ConfigurationChangeEvent) => {
			if (e.affectsConfiguration('antigravity-ssh-proxy.remoteProxyHost') ||
				e.affectsConfiguration('antigravity-ssh-proxy.remoteProxyPort') ||
				e.affectsConfiguration('antigravity-ssh-proxy.proxyType')) {
				const cfg = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
				const host = cfg.get<string>('remoteProxyHost', '127.0.0.1');
				const port = cfg.get<number>('remoteProxyPort', 7890);
				const type = cfg.get<string>('proxyType', 'http');
				log(`Config changed, re-running setup: ${host}:${port} (${type})`);
				const success = await runSetupScriptSilently(host, port, type, extensionPath);
				statusManager.updateLanguageServerStatus(success);
				await statusManager.refreshStatus();
			}
		})
	);

	// Remote commands
	context.subscriptions.push(
		vscode.commands.registerCommand('antigravity-ssh-proxy.setup', () => {
			const cfg = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
			const type = cfg.get<string>('proxyType', 'http');
			const terminal = vscode.window.createTerminal('Antigravity Setup');
			terminal.show();
			const script = generateSetupScript(remoteHost, remotePort, type, extensionPath);
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
			await showStartupStatus(remoteHost, remotePort, setupSuccess);
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
async function showStartupStatus(proxyHost: string, proxyPort: number, setupSuccess: boolean = true): Promise<void> {
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

		if (!setupSuccess) {
			message = `⚠️ Proxy wrapper setup failed. Check output logs or run Diagnostics.`;
			actions = ['Run Diagnostics', 'Dismiss'];
		} else if (proxyReachable && lsActuallyUsingProxy) {
			// Everything is actually working - LS is using proxy
			message = `✅ Proxy active (${proxyHost}:${proxyPort})`;
		} else if (proxyReachable && lsNeedsRestart) {
			// LS is in persistent mode but not using proxy - this is the bug scenario
			// Auto-fix by killing LS
			log('Startup: Detected persistent_mode LS not using proxy, auto-fixing...');
			
			const oldPid = lsProcessForDecision?.pid;
			const killed = await killLanguageServer(oldPid);
			if (killed) {
				// Poll for Antigravity IDE v2.6.0+ auto-recovery to respawn agy through wrapper
				const rechecked = await waitForProxiedLanguageServer(3500, oldPid);
				if (rechecked?.isUsingProxy) {
					log('Startup: Language Server auto-recovered with proxy active');
					message = `✅ Proxy active (${proxyHost}:${proxyPort})`;
					actions = [];
				} else {
					message = `🔄 Language Server restarted to enable proxy. Please reload window.`;
					actions = ['Reload Now', 'Dismiss'];
				}
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

let setupQueuePromise: Promise<boolean> = Promise.resolve(true);

/**
 * Run setup script silently in background (idempotent and serialized)
 * @returns true if setup was successful or already configured
 */
async function runSetupScriptSilently(proxyHost: string, proxyPort: number, proxyType: string, extensionPath: string): Promise<boolean> {
	const nextRun = setupQueuePromise.catch(() => false).then(() =>
		runSetupScriptSilentlyInner(proxyHost, proxyPort, proxyType, extensionPath)
	);
	setupQueuePromise = nextRun;
	return nextRun;
}

async function runSetupScriptSilentlyInner(proxyHost: string, proxyPort: number, proxyType: string, extensionPath: string): Promise<boolean> {
	const scriptPath = path.join(extensionPath, 'scripts', 'setup-proxy.sh');

	try {
		// Ensure script is executable
		await execAsync(`chmod +x "${scriptPath}"`);

		// Read extension version from package.json
		const packageJsonPath = path.join(extensionPath, 'package.json');
		let extensionVersion = 'unknown';
		try {
			const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
			const packageJson = JSON.parse(packageJsonContent);
			extensionVersion = packageJson.version || 'unknown';
		} catch (e) {
			log(`Failed to read package.json: ${e}`);
		}

		// Record existing Language Server / agy PID before applying wrapper
		const pidBeforeSetup = (await getLanguageServerProcess())?.pid;

		// Execute script directly with environment variables for proxy config.
		// Pass SKIP_AGY_KILL=1 so setup-proxy.sh replaces ~/.gemini/bin/agy and syncs agy.version.json
		// immediately without killing an agy --hub process that may still be in its initial /healthz probe.
		const env = {
			...process.env,
			PROXY_HOST: proxyHost,
			PROXY_PORT: String(proxyPort),
			PROXY_TYPE: proxyType,
			EXTENSION_PATH: extensionPath,  // Current extension's exact path
			EXTENSION_VERSION: extensionVersion,  // Extension version for update detection
			SKIP_AGY_KILL: '1'
		};

		const { stdout, stderr } = await execAsync(`bash "${scriptPath}" 2>&1`, { env });
		const output = stdout || stderr || '';

		log(`Setup output: ${output}`);

		// Check if this is a new configuration
		const isNewConfig = output.includes('Setup complete') ||
			(output.includes('configured') && !output.includes('Already configured'));

		if (isNewConfig) {
			log('Setup: New configuration applied');
			
			// Wait 1.5s so that if Antigravity IDE v2.6.0+ just spawned agy --hub right after writing
			// agy.version.json, its waitForServerReady(/healthz) probe completes and sets serverUrl
			// (enabling 1s auto-recovery on SIGTERM instead of throwing a startup error).
			await new Promise(resolve => setTimeout(resolve, 1500));
			const lsProcess = await getLanguageServerProcess();
			if (lsProcess && lsProcess.isUsingProxy && lsProcess.pid !== pidBeforeSetup) {
				log('Setup: Language Server already spawned with new proxy wrapper active, no reload needed');
				return true;
			}
			if (lsProcess && lsProcess.isPersistent && (!lsProcess.isUsingProxy || lsProcess.pid === pidBeforeSetup)) {
				log(`Setup: Restarting persistent LS/agy (PID ${lsProcess.pid}, usingProxy=${lsProcess.isUsingProxy}) to apply new wrapper`);
				const killed = await killLanguageServer(lsProcess.pid);
				if (killed) {
					const rechecked = await waitForProxiedLanguageServer(3500, lsProcess.pid);
					if (rechecked?.isUsingProxy) {
						log('Setup: Language Server auto-recovered with proxy active after kill');
						return true;
					}
					promptReloadWindow(
						'Antigravity proxy updated. Language Server restarted. Please reload the window to reconnect.'
					);
				} else {
					vscode.window.showWarningMessage(
						'Proxy updated but Language Server needs restart. ' +
						'Run in terminal: pkill -f language_server_linux || pkill -f agy && then reload window.',
						'Reload Now'
					).then(selection => {
						if (selection === 'Reload Now') {
							vscode.commands.executeCommand('workbench.action.reloadWindow');
						}
					});
				}
			} else if (!lsProcess) {
				// LS not running yet or waiting to start - check briefly if it starts with proxy
				const started = await waitForProxiedLanguageServer(2000);
				if (started?.isUsingProxy) {
					log('Setup: Language Server started with proxy active, no reload needed');
					return true;
				}
			} else {
				// Non-persistent mode - regular reload is fine
				promptReloadWindow(
					'Antigravity proxy configured. Reload window to apply changes to the language server.'
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
					// Persistent mode: kill it so Antigravity v2.6.0+ auto-recovers through wrapper
					log('Setup: Language Server is in persistent_mode, killing process to force restart through wrapper');
					
					const killed = await killLanguageServer(lsProcess.pid);
					if (killed) {
						const rechecked = await waitForProxiedLanguageServer(3500, lsProcess.pid);
						if (rechecked?.isUsingProxy) {
							log('Setup: Language Server auto-recovered with proxy active after kill');
							return true;
						}
						promptReloadWindow(
							'Language Server was restarted to enable proxy. Please reload the window to reconnect.'
						);
					} else {
						// Fallback to manual instructions
						vscode.window.showWarningMessage(
							'Proxy configured but Language Server needs restart. ' +
							'Run in terminal: pkill -f language_server_linux || pkill -f agy && then reload window.',
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
						'Proxy is configured but not active. Reload window to enable proxy for the language server.'
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
			await updateSSHConfigFile(0, 0, false);
		} catch (e) {
			log(`Cleanup during deactivation failed: ${e}`);
		}
	}
}
