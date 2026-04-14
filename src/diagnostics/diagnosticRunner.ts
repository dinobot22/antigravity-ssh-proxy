import * as vscode from 'vscode';
import * as net from 'net';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getRemoteCodexProfileBridgePort } from '../codexProfileBridge';

const execAsync = promisify(exec);

export interface DiagnosticCheck {
    id: string;
    name: string;
    status: 'pending' | 'running' | 'success' | 'warning' | 'error';
    message?: string;
    suggestion?: string;
    // For external connectivity check - protocol test results
    protocolResults?: ProtocolTestResult[];
    currentProtocol?: string;
}

export interface ProtocolTestResult {
    protocol: 'http' | 'socks5';
    success: boolean;
    httpCode?: string;
    error?: string;
    isCurrent: boolean;
}

export interface DiagnosticReport {
    timestamp: Date;
    checks: DiagnosticCheck[];
    overallStatus: 'healthy' | 'degraded' | 'broken';
}

type ProgressCallback = (checks: DiagnosticCheck[]) => void;

function isRunningLocally(): boolean {
    return !vscode.env.remoteName;
}

/**
 * Check if a port is reachable
 */
function checkPort(host: string, port: number, timeout: number = 3000): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(timeout);
        socket.on('connect', () => { socket.destroy(); resolve(true); });
        socket.on('timeout', () => { socket.destroy(); resolve(false); });
        socket.on('error', () => { socket.destroy(); resolve(false); });
        socket.connect(port, host);
    });
}

/**
 * Get SSH config path
 */
function getSSHConfigPath(): string {
    return path.join(os.homedir(), '.ssh', 'config');
}

/**
 * Check local proxy service
 */
async function checkLocalProxy(localProxyPort: number): Promise<DiagnosticCheck> {
    const check: DiagnosticCheck = {
        id: 'local-proxy',
        name: 'Local Proxy Service',
        status: 'running'
    };

    try {
        const reachable = await checkPort('127.0.0.1', localProxyPort);
        if (reachable) {
            check.status = 'success';
            check.message = `Local proxy is running on port ${localProxyPort}`;
        } else {
            check.status = 'error';
            check.message = `Cannot connect to local proxy on port ${localProxyPort}`;
            check.suggestion = 'Please ensure your local proxy (e.g., Clash, V2Ray) is running and listening on the configured port.';
        }
    } catch (error) {
        check.status = 'error';
        check.message = `Error checking local proxy: ${error}`;
        check.suggestion = 'Please check if your proxy software is installed and running.';
    }

    return check;
}

/**
 * Check SSH config for RemoteForward
 */
async function checkSSHConfig(remoteProxyPort: number): Promise<DiagnosticCheck> {
    const check: DiagnosticCheck = {
        id: 'ssh-config',
        name: 'SSH Configuration',
        status: 'running'
    };

    try {
        const configPath = getSSHConfigPath();
        const content = await fs.readFile(configPath, 'utf-8');
        
        // Check for Include line
        if (content.includes('Include config.antigravity')) {
            // Check the antigravity config file
            const antiConfigPath = path.join(os.homedir(), '.ssh', 'config.antigravity');
            try {
                const antiContent = await fs.readFile(antiConfigPath, 'utf-8');
                const match = antiContent.match(/RemoteForward\s+(\d+)\s+/);
                if (match) {
                    const configuredPort = parseInt(match[1]);
                    if (configuredPort === remoteProxyPort) {
                        check.status = 'success';
                        check.message = `SSH RemoteForward configured for port ${remoteProxyPort}`;
                    } else {
                        check.status = 'warning';
                        check.message = `RemoteForward port mismatch: configured ${configuredPort}, expected ${remoteProxyPort}`;
                        check.suggestion = 'Run "Enable Port Forwarding" command to update the SSH configuration.';
                    }
                } else {
                    check.status = 'error';
                    check.message = 'RemoteForward directive not found in config.antigravity';
                    check.suggestion = 'Run "Enable Port Forwarding" command to configure SSH.';
                }
            } catch {
                check.status = 'error';
                check.message = 'config.antigravity file not found';
                check.suggestion = 'Run "Enable Port Forwarding" command to create SSH configuration.';
            }
        } else {
            check.status = 'error';
            check.message = 'SSH config does not include config.antigravity';
            check.suggestion = 'Run "Enable Port Forwarding" command to configure SSH.';
        }
    } catch {
        check.status = 'error';
        check.message = 'Cannot read SSH config file';
        check.suggestion = 'Ensure ~/.ssh/config exists and is readable.';
    }

    return check;
}

/**
 * Check remote port forwarding
 */
async function checkRemotePortForward(remoteProxyHost: string, remoteProxyPort: number): Promise<DiagnosticCheck> {
    const check: DiagnosticCheck = {
        id: 'remote-forward',
        name: 'Remote Port Forwarding',
        status: 'running'
    };

    try {
        const reachable = await checkPort(remoteProxyHost, remoteProxyPort);
        if (reachable) {
            check.status = 'success';
            check.message = `Remote proxy port ${remoteProxyHost}:${remoteProxyPort} is reachable`;
        } else {
            check.status = 'error';
            check.message = `Cannot connect to ${remoteProxyHost}:${remoteProxyPort}`;
            check.suggestion = 'Reconnect to the remote server to establish the SSH tunnel. Check if the port is occupied on the remote server.';
        }
    } catch (error) {
        check.status = 'error';
        check.message = `Error checking remote port: ${error}`;
        check.suggestion = 'Please reconnect to the remote server.';
    }

    return check;
}

/**
 * Check mgraftcp-fakedns availability
 * Uses the exact extension path for precise detection
 */
async function checkMgraftcp(extensionPath?: string): Promise<DiagnosticCheck> {
    const check: DiagnosticCheck = {
        id: 'mgraftcp',
        name: 'mgraftcp-fakedns Binary',
        status: 'running'
    };

    try {
        const arch = process.arch === 'x64' ? 'amd64' : 'arm64';
        // Use the correct binary name: mgraftcp-fakedns (not mgraftcp)
        const binaryName = `mgraftcp-fakedns-linux-${arch}`;
        const libName = `libdnsredir-linux-${arch}.so`;
        const homeDir = os.homedir();
        
        // Check if we're in a misconfigured environment (Windows path on Linux check)
        if (homeDir.includes(':\\') || homeDir.includes('\\Users\\')) {
            check.status = 'error';
            check.message = 'Remote extension not installed on the remote server';
            check.suggestion = 'Please install "Antigravity SSH Proxy" extension on the remote server: Open Extensions sidebar (Ctrl+Shift+X) → Search "Antigravity SSH Proxy" → Click "Install in SSH: <host>" button.';
            return check;
        }
        
        let binaryPath = '';
        let libPath = '';
        
        // Method 1: Use exact extension path if provided (preferred)
        if (extensionPath) {
            const exactBinaryPath = path.join(extensionPath, 'resources', 'bin', binaryName);
            const exactLibPath = path.join(extensionPath, 'resources', 'bin', libName);
            try {
                await fs.access(exactBinaryPath, fs.constants.X_OK);
                binaryPath = exactBinaryPath;
                // Check lib file (optional but recommended)
                try {
                    await fs.access(exactLibPath, fs.constants.R_OK);
                    libPath = exactLibPath;
                } catch {
                    // Lib file is optional
                }
            } catch {
                // Binary not found or not executable at exact path, fall through to search
            }
        }
        
        // Method 2: Fallback - search in all versions (sorted by version, newest first)
        if (!binaryPath) {
            const searchPattern = `${homeDir}/.antigravity-server/extensions/*antigravity-ssh-proxy*/resources/bin/${binaryName}`;
            const { stdout } = await execAsync(`ls ${searchPattern} 2>/dev/null | sort -V -r | head -1`);
            binaryPath = stdout.trim();
            
            if (binaryPath) {
                // Check if executable
                await fs.access(binaryPath, fs.constants.X_OK);
            }
        }

        if (binaryPath) {
            check.status = 'success';
            if (libPath) {
                check.message = `mgraftcp-fakedns found at ${binaryPath} (with libdnsredir)`;
            } else {
                check.message = `mgraftcp-fakedns found at ${binaryPath}`;
            }
        } else {
            check.status = 'error';
            check.message = 'mgraftcp-fakedns binary not found';
            check.suggestion = 'Please install "Antigravity SSH Proxy" extension on the remote server: Open Extensions sidebar (Ctrl+Shift+X) → Search "Antigravity SSH Proxy" → Click "Install in SSH: <host>" button.';
        }
    } catch (error) {
        const errorStr = String(error);
        // Check for Windows path error indicators
        if (errorStr.includes(':\\') || errorStr.includes('\\Users\\') || errorStr.includes('系统找不到')) {
            check.status = 'error';
            check.message = 'Remote extension not installed on the remote server';
            check.suggestion = 'Please install "Antigravity SSH Proxy" extension on the remote server: Open Extensions sidebar (Ctrl+Shift+X) → Search "Antigravity SSH Proxy" → Click "Install in SSH: <host>" button.';
        } else {
            check.status = 'error';
            check.message = `Error checking mgraftcp-fakedns: ${error}`;
            check.suggestion = 'Please install "Antigravity SSH Proxy" extension on the remote server: Open Extensions sidebar (Ctrl+Shift+X) → Search "Antigravity SSH Proxy" → Click "Install in SSH: <host>" button.';
        }
    }

    return check;
}

/**
 * Check language server wrapper
 */
async function checkLanguageServerWrapper(extensionPath?: string): Promise<DiagnosticCheck> {
    const check: DiagnosticCheck = {
        id: 'ls-wrapper',
        name: 'Language Server Wrapper',
        status: 'running'
    };

    try {
        const homeDir = os.homedir();
        
        // Check if we're in a misconfigured environment (Windows path on Linux check)
        if (homeDir.includes(':\\') || homeDir.includes('\\Users\\')) {
            check.status = 'error';
            check.message = 'Remote extension not installed on the remote server';
            check.suggestion = 'Please install "Antigravity SSH Proxy" extension on the remote server: Open Extensions sidebar (Ctrl+Shift+X) → Search "Antigravity SSH Proxy" → Click "Install in SSH: <host>" button.';
            return check;
        }
        
        const { stdout } = await execAsync(
            `find "$HOME/.antigravity-server/bin" -path "*/extensions/antigravity/bin/language_server_linux_*" -type f 2>/dev/null | grep -v ".bak$" | head -1`
        );
        const targetPath = stdout.trim();

        if (!targetPath) {
            check.status = 'warning';
            check.message = 'Language server binary not found';
            check.suggestion = 'This may be normal if Antigravity extension is not installed.';
            return check;
        }

        // Check if it's a wrapper script
        const content = await fs.readFile(targetPath, 'utf-8');
        if (content.startsWith('#!/bin/bash') && content.includes('mgraftcp')) {
            check.status = 'success';
            
            // Extract wrapper version
            let wrapperVersion = 'unknown';
            const versionMatch = content.match(/WRAPPER_VERSION="([^"]+)"/);
            if (versionMatch) {
                wrapperVersion = versionMatch[1];
            }

            // Get extension version
            let extensionVersion = 'unknown';
            if (extensionPath) {
                try {
                    const packageJsonPath = path.join(extensionPath, 'package.json');
                    const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
                    const packageJson = JSON.parse(packageJsonContent);
                    extensionVersion = packageJson.version || 'unknown';
                } catch {
                    // Ignore error
                }
            }

            check.message = `Language server wrapper is configured (Wrapper v${wrapperVersion}, Extension v${extensionVersion})`;
            
            // Warn if versions mismatch
            if (extensionVersion !== 'unknown' && wrapperVersion !== 'unknown' && 
                wrapperVersion !== extensionVersion && extensionVersion !== '__EXTENSION_VERSION_PLACEHOLDER__') {
                check.status = 'warning';
                check.message += ' - Version mismatch, update recommended';
                check.suggestion = 'Run "Setup Remote Environment" command to update the wrapper.';
            }
        } else {
            check.status = 'warning';
            check.message = 'Language server is not wrapped with mgraftcp';
            check.suggestion = 'Run "Setup Remote Environment" command to configure the wrapper.';
        }
    } catch (error) {
        const errorStr = String(error);
        // Check for Windows path error indicators
        if (errorStr.includes(':\\') || errorStr.includes('\\Users\\') || errorStr.includes('系统找不到')) {
            check.status = 'error';
            check.message = 'Remote extension not installed on the remote server';
            check.suggestion = 'Please install "Antigravity SSH Proxy" extension on the remote server: Open Extensions sidebar (Ctrl+Shift+X) → Search "Antigravity SSH Proxy" → Click "Install in SSH: <host>" button.';
        } else {
            check.status = 'warning';
            check.message = `Could not verify wrapper: ${error}`;
            check.suggestion = 'Run "Setup Remote Environment" command if language server proxy is needed.';
        }
    }

    return check;
}

/**
 * Check Language Server process status
 * Detects if LS is running, in persistent mode, and using proxy
 */
async function checkLanguageServerProcess(): Promise<DiagnosticCheck> {
    const check: DiagnosticCheck = {
        id: 'ls-process',
        name: 'Language Server Process',
        status: 'running'
    };

    try {
        const { stdout } = await execAsync('ps aux | grep language_server_linux | grep -v grep');
        const lines = stdout.trim().split('\n').filter(l => l.length > 0);

        if (lines.length === 0) {
            check.status = 'warning';
            check.message = 'Language Server is not running';
            check.suggestion = 'This may be normal if you haven\'t used any AI features yet. The LS starts on demand.';
            return check;
        }

        // Check if mgraftcp is wrapping the LS
        const hasMgraftcpWrapper = lines.some(line => line.includes('mgraftcp'));
        
        // Find the actual LS process
        let isPersistent = false;
        let lsPid = 0;
        
        for (const line of lines) {
            if (line.includes('mgraftcp-fakedns')) {
                continue; // Skip the wrapper process line
            }
            if (line.includes('language_server_linux')) {
                const parts = line.split(/\s+/);
                if (parts.length >= 2) {
                    lsPid = parseInt(parts[1]);
                    isPersistent = line.includes('--persistent_mode') || line.includes('persistent_mode');
                }
            }
        }

        // Build status message
        const modeLabel = isPersistent ? 'persistent mode' : 'normal mode';
        const proxyLabel = hasMgraftcpWrapper ? 'using proxy' : 'NOT using proxy';
        
        if (hasMgraftcpWrapper) {
            check.status = 'success';
            check.message = `Language Server (PID ${lsPid}) is running in ${modeLabel}, ${proxyLabel}`;
        } else if (isPersistent) {
            // Persistent mode but not using proxy - this is the bug scenario
            check.status = 'error';
            check.message = `Language Server (PID ${lsPid}) is running in ${modeLabel}, but ${proxyLabel}`;
            check.suggestion = 'The LS was started before the proxy wrapper was configured. ' +
                'Kill the LS process and reload: Run "kill ' + lsPid + '" in terminal, then reload window.';
        } else {
            // Non-persistent mode, not using proxy
            check.status = 'warning';
            check.message = `Language Server (PID ${lsPid}) is running in ${modeLabel}, ${proxyLabel}`;
            check.suggestion = 'Reload the window to restart LS with proxy support.';
        }

    } catch {
        // grep returns non-zero if no match
        check.status = 'warning';
        check.message = 'Language Server is not running';
        check.suggestion = 'This may be normal if you haven\'t used any AI features yet.';
    }

    return check;
}

async function checkCodexWrapper(extensionPath?: string): Promise<DiagnosticCheck> {
    const check: DiagnosticCheck = {
        id: 'codex-wrapper',
        name: 'Codex Wrapper',
        status: 'running'
    };

    try {
        const { stdout } = await execAsync(
            `find "$HOME/.antigravity-server/extensions" -path "*/openai.chatgpt-*/bin/linux-*/codex" -type f 2>/dev/null | grep -v ".bak$" | head -1`
        );
        const targetPath = stdout.trim();

        if (!targetPath) {
            check.status = 'warning';
            check.message = 'Codex binary not found';
            check.suggestion = 'This may be normal if the ChatGPT/Codex extension is not installed on the remote host.';
            return check;
        }

        const content = await fs.readFile(targetPath, 'utf-8');
        if (content.startsWith('#!/bin/bash') && (content.includes('WRAPPED_TARGET="codex"') || content.includes('mgraftcp'))) {
            check.status = 'success';

            let wrapperVersion = 'unknown';
            const versionMatch = content.match(/WRAPPER_VERSION="([^"]+)"/);
            if (versionMatch) {
                wrapperVersion = versionMatch[1];
            }

            let extensionVersion = 'unknown';
            if (extensionPath) {
                try {
                    const packageJsonContent = await fs.readFile(path.join(extensionPath, 'package.json'), 'utf-8');
                    extensionVersion = JSON.parse(packageJsonContent).version || 'unknown';
                } catch {
                    // ignore
                }
            }

            check.message = `Codex wrapper is configured (Wrapper v${wrapperVersion}, Extension v${extensionVersion})`;
            if (extensionVersion !== 'unknown' && wrapperVersion !== 'unknown' && wrapperVersion !== extensionVersion) {
                check.status = 'warning';
                check.message += ' - Version mismatch, update recommended';
                check.suggestion = 'Run "Setup Remote Environment" to refresh the Codex wrapper.';
            }
        } else {
            check.status = 'warning';
            check.message = 'Codex is not wrapped with mgraftcp';
            check.suggestion = 'Run "Setup Remote Environment" to configure the Codex wrapper.';
        }
    } catch (error) {
        check.status = 'warning';
        check.message = `Could not verify Codex wrapper: ${error}`;
        check.suggestion = 'Run "Setup Remote Environment" if Codex proxying is required.';
    }

    return check;
}

async function checkCodexProcess(): Promise<DiagnosticCheck> {
    const check: DiagnosticCheck = {
        id: 'codex-process',
        name: 'Codex Process',
        status: 'running'
    };

    try {
        const { stdout } = await execAsync(`ps -eo pid,args | grep -E 'codex|mgraftcp-fakedns' | grep -v grep`);
        const lines = stdout.trim().split('\n').filter(Boolean);

        const codexLines = lines.filter(line => line.includes('/codex') || line.includes(' codex ') || line.includes('codex.bak'));
        if (codexLines.length === 0) {
            check.status = 'warning';
            check.message = 'Codex is not running';
            check.suggestion = 'This is normal until you open ChatGPT/Codex or start an agent request.';
            return check;
        }

        const wrappedLine = lines.find(line => line.includes('mgraftcp-fakedns') && line.includes('codex.bak'));
        const pid = codexLines[0]?.trim().split(/\s+/, 2)[0] ?? '?';

        if (wrappedLine) {
            check.status = 'success';
            check.message = `Codex (PID ${pid}) is running through mgraftcp`;
        } else {
            check.status = 'warning';
            check.message = `Codex (PID ${pid}) is running but ATP did not detect an mgraftcp wrapper`;
            check.suggestion = 'Trigger a fresh Codex request after ATP setup, or reload the remote window.';
        }
    } catch {
        check.status = 'warning';
        check.message = 'Codex is not running';
        check.suggestion = 'This is normal until you open ChatGPT/Codex or start an agent request.';
    }

    return check;
}

async function checkCodexProfileBridge(remoteProxyHost: string, remoteProxyPort: number): Promise<DiagnosticCheck> {
    const bridgePort = getRemoteCodexProfileBridgePort(remoteProxyPort);
    const check: DiagnosticCheck = {
        id: 'codex-bridge',
        name: 'Codex Profile Bridge',
        status: 'running'
    };

    try {
        const reachable = await checkPort(remoteProxyHost, bridgePort);
        if (reachable) {
            check.status = 'success';
            check.message = `Local Codex profile bridge is reachable at ${remoteProxyHost}:${bridgePort}`;
        } else {
            check.status = 'warning';
            check.message = `Cannot reach Codex profile bridge at ${remoteProxyHost}:${bridgePort}`;
            check.suggestion = 'Reconnect the SSH remote after updating local ATP so the extra RemoteForward for Codex profile sync can take effect.';
        }
    } catch (error) {
        check.status = 'warning';
        check.message = `Could not verify Codex profile bridge: ${error}`;
        check.suggestion = 'Reconnect the SSH remote after updating local ATP.';
    }

    return check;
}

/**
 * Check external connectivity through proxy
 * Tests both HTTP and SOCKS5 protocols and reports availability of each
 */
async function checkExternalConnectivity(remoteProxyHost: string, remoteProxyPort: number, currentProxyType: string): Promise<DiagnosticCheck> {
    const check: DiagnosticCheck = {
        id: 'external-connectivity',
        name: 'External Connectivity',
        status: 'running',
        currentProtocol: currentProxyType
    };

    // Test both protocols
    const protocols: Array<'http' | 'socks5'> = ['http', 'socks5'];
    const results: ProtocolTestResult[] = [];
    
    for (const protocol of protocols) {
        const result: ProtocolTestResult = {
            protocol,
            success: false,
            isCurrent: protocol === currentProxyType
        };
        
        try {
            const { stdout } = await execAsync(
                `curl -x ${protocol}://${remoteProxyHost}:${remoteProxyPort} https://www.google.com -o /dev/null -s -w "%{http_code}" --connect-timeout 10`,
                { timeout: 15000 }
            );
            const httpCode = stdout.trim();
            
            if (httpCode === '200' || httpCode === '301' || httpCode === '302') {
                result.success = true;
                result.httpCode = httpCode;
            } else {
                result.error = `HTTP ${httpCode}`;
            }
        } catch (error) {
            result.error = 'Connection failed';
        }
        
        results.push(result);
    }
    
    check.protocolResults = results;
    
    // Determine status based on current protocol and available protocols
    const currentResult = results.find(r => r.isCurrent);
    const anySuccess = results.some(r => r.success);
    const currentSuccess = currentResult?.success ?? false;
    
    if (currentSuccess) {
        // Current protocol works
        check.status = 'success';
        const availableCount = results.filter(r => r.success).length;
        check.message = `Current protocol (${currentProxyType.toUpperCase()}) is working. ${availableCount}/${protocols.length} protocols available.`;
    } else if (anySuccess) {
        // Current protocol doesn't work, but others do
        check.status = 'warning';
        const workingProtocols = results.filter(r => r.success).map(r => r.protocol.toUpperCase()).join(', ');
        check.message = `Current protocol (${currentProxyType.toUpperCase()}) is not working.`;
        check.suggestion = `Consider switching to ${workingProtocols} which is available.`;
    } else {
        // No protocols work
        check.status = 'error';
        check.message = 'No proxy protocol is working.';
        check.suggestion = 'Check if the proxy is properly forwarding traffic. Verify your local proxy has internet access.';
    }

    return check;
}

/**
 * Run all diagnostic checks
 * @param onProgress - Optional callback for progress updates
 * @param extensionPath - Optional path to the current extension for precise binary detection
 */
export async function runDiagnostics(onProgress?: ProgressCallback, extensionPath?: string): Promise<DiagnosticReport> {
    const config = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
    const localProxyPort = config.get<number>('localProxyPort', 7890);
    const remoteProxyPort = config.get<number>('remoteProxyPort', 7890);
    const remoteProxyHost = config.get<string>('remoteProxyHost', '127.0.0.1');
    const proxyType = config.get<string>('proxyType', 'http');
    const isLocal = isRunningLocally();

    // Initialize all checks as pending
    const checks: DiagnosticCheck[] = [
        { id: 'local-proxy', name: 'Local Proxy Service', status: 'pending' },
        { id: 'ssh-config', name: 'SSH Configuration', status: 'pending' },
        { id: 'remote-forward', name: 'Remote Port Forwarding', status: 'pending' },
        { id: 'mgraftcp', name: 'mgraftcp-fakedns Binary', status: 'pending' },
        { id: 'ls-wrapper', name: 'Language Server Wrapper', status: 'pending' },
        { id: 'ls-process', name: 'Language Server Process', status: 'pending' },
        { id: 'codex-wrapper', name: 'Codex Wrapper', status: 'pending' },
        { id: 'codex-process', name: 'Codex Process', status: 'pending' },
        { id: 'codex-bridge', name: 'Codex Profile Bridge', status: 'pending' },
        { id: 'external-connectivity', name: 'External Connectivity', status: 'pending' }
    ];

    const updateCheck = (index: number, check: DiagnosticCheck) => {
        checks[index] = check;
        onProgress?.(checks);
    };

    // Run checks sequentially
    if (isLocal) {
        // Local environment: check steps 1-2
        checks[0].status = 'running';
        onProgress?.(checks);
        updateCheck(0, await checkLocalProxy(localProxyPort));

        checks[1].status = 'running';
        onProgress?.(checks);
        updateCheck(1, await checkSSHConfig(remoteProxyPort));

        // Skip remote-only checks
        for (let i = 2; i < checks.length; i++) {
            checks[i].status = 'warning';
            checks[i].message = 'Skipped (remote-only check)';
        }
        onProgress?.(checks);
    } else {
        // Remote environment: skip local checks
        checks[0].status = 'warning';
        checks[0].message = 'Skipped (local-only check)';
        checks[1].status = 'warning';
        checks[1].message = 'Skipped (local-only check)';
        onProgress?.(checks);

        // Run remote checks
        checks[2].status = 'running';
        onProgress?.(checks);
        updateCheck(2, await checkRemotePortForward(remoteProxyHost, remoteProxyPort));

        checks[3].status = 'running';
        onProgress?.(checks);
        updateCheck(3, await checkMgraftcp(extensionPath));

        checks[4].status = 'running';
        onProgress?.(checks);
        updateCheck(4, await checkLanguageServerWrapper(extensionPath));

        checks[5].status = 'running';
        onProgress?.(checks);
        updateCheck(5, await checkLanguageServerProcess());

        checks[6].status = 'running';
        onProgress?.(checks);
        updateCheck(6, await checkCodexWrapper(extensionPath));

        checks[7].status = 'running';
        onProgress?.(checks);
        updateCheck(7, await checkCodexProcess());

        checks[8].status = 'running';
        onProgress?.(checks);
        updateCheck(8, await checkCodexProfileBridge(remoteProxyHost, remoteProxyPort));

        checks[9].status = 'running';
        onProgress?.(checks);
        updateCheck(9, await checkExternalConnectivity(remoteProxyHost, remoteProxyPort, proxyType));
    }

    // Determine overall status
    const errorCount = checks.filter(c => c.status === 'error').length;
    const warningCount = checks.filter(c => c.status === 'warning' && !c.message?.includes('Skipped')).length;
    
    let overallStatus: 'healthy' | 'degraded' | 'broken';
    if (errorCount > 0) {
        overallStatus = 'broken';
    } else if (warningCount > 0) {
        overallStatus = 'degraded';
    } else {
        overallStatus = 'healthy';
    }

    return {
        timestamp: new Date(),
        checks,
        overallStatus
    };
}

/**
 * Generate a text report for copying
 */
export function generateReportText(report: DiagnosticReport): string {
    const lines: string[] = [
        '=== Antigravity SSH Proxy Diagnostic Report ===',
        `Timestamp: ${report.timestamp.toISOString()}`,
        `Overall Status: ${report.overallStatus.toUpperCase()}`,
        `Environment: ${isRunningLocally() ? 'Local' : 'Remote'}`,
        '',
        '--- Checks ---'
    ];

    for (const check of report.checks) {
        const icon = check.status === 'success' ? '✓' : 
                     check.status === 'warning' ? '⚠' : 
                     check.status === 'error' ? '✗' : '○';
        lines.push(`[${icon}] ${check.name}: ${check.message || check.status}`);
        
        // Add protocol test results for external-connectivity check
        if (check.protocolResults && check.protocolResults.length > 0) {
            for (let i = 0; i < check.protocolResults.length; i++) {
                const result = check.protocolResults[i];
                const isLast = i === check.protocolResults.length - 1;
                const prefix = isLast ? '└──' : '├──';
                const statusIcon = result.success ? '✓' : '✗';
                const statusText = result.success ? 'Available' : 'Not working';
                const currentLabel = result.isCurrent ? ' ← Current' : '';
                lines.push(`    ${prefix} ${result.protocol.toUpperCase()}: ${statusIcon} ${statusText}${currentLabel}`);
            }
        }
        
        if (check.suggestion) {
            lines.push(`    Suggestion: ${check.suggestion}`);
        }
    }

    lines.push('');
    lines.push('=== End of Report ===');
    return lines.join('\n');
}
