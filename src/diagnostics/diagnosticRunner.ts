import * as vscode from 'vscode';
import * as net from 'net';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Possible Antigravity server directory names, in priority order.
 * IDE renamed from .antigravity-server to .antigravity-ide-server in 2.x+.
 */
const SERVER_DIR_NAMES = ['.antigravity-ide-server', '.antigravity-server'];

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
        
        // Method 1.5: Check server mgraftcp directory
        if (!binaryPath) {
            for (const dirName of SERVER_DIR_NAMES) {
                const directBinaryPath = path.join(homeDir, dirName, 'mgraftcp', binaryName);
                const directLibPath = path.join(homeDir, dirName, 'mgraftcp', libName);
                try {
                    await fs.access(directBinaryPath, fs.constants.X_OK);
                    binaryPath = directBinaryPath;
                    try {
                        await fs.access(directLibPath, fs.constants.R_OK);
                        libPath = directLibPath;
                    } catch {
                        // Lib file is optional
                    }
                    break;
                } catch {
                    // Not found
                }
            }
        }

        // Method 2: Fallback - search in all possible server dirs and versions
        if (!binaryPath) {
            for (const dirName of SERVER_DIR_NAMES) {
                const searchPattern = `${homeDir}/${dirName}/extensions/*antigravity-ssh-proxy*/resources/bin/${binaryName}`;
                try {
                    const { stdout } = await execAsync(`ls ${searchPattern} 2>/dev/null | sort -V -r | head -1`);
                    binaryPath = stdout.trim();
                    if (binaryPath) {
                        await fs.access(binaryPath, fs.constants.X_OK);
                        break;
                    }
                } catch {
                    binaryPath = '';
                }
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

        // 1. Check Antigravity IDE v2.6.0+ target (~/.gemini/bin/agy)
        const agyPath = path.join(homeDir, '.gemini', 'bin', 'agy');
        const agyBakPath = path.join(homeDir, '.gemini', 'bin', 'agy.bak');

        let agyExists = false;
        let agyIsWrapper = false;
        let agyHasBak = false;
        let agyWrapperVersion = 'unknown';

        try {
            await fs.access(agyPath);
            agyExists = true;
            const content = await fs.readFile(agyPath, 'utf-8');
            if (content.startsWith('#!/bin/bash') && content.includes('mgraftcp')) {
                agyIsWrapper = true;
                const versionMatch = content.match(/WRAPPER_VERSION="([^"]+)"/);
                if (versionMatch) {
                    agyWrapperVersion = versionMatch[1];
                }
            }
        } catch {
            // Not found
        }

        try {
            await fs.access(agyBakPath);
            agyHasBak = true;
        } catch {
            // Backup not found
        }

        // 2. Check legacy language server targets (pre-v2.6.0)
        let legacyPath = '';
        let legacyIsWrapper = false;
        let legacyHasBak = false;
        let legacyWrapperVersion = 'unknown';

        for (const dirName of SERVER_DIR_NAMES) {
            try {
                const { stdout } = await execAsync(
                    `find "$HOME/${dirName}/bin" -path "*/extensions/antigravity/bin/language_server_linux_*" -type f 2>/dev/null | grep -v "\\.bak$" | head -1`
                );
                const found = stdout.trim();
                if (found) {
                    legacyPath = found;
                    const legacyBakPath = `${found}.bak`;
                    const content = await fs.readFile(legacyPath, 'utf-8');
                    if (content.startsWith('#!/bin/bash') && content.includes('mgraftcp')) {
                        legacyIsWrapper = true;
                        const versionMatch = content.match(/WRAPPER_VERSION="([^"]+)"/);
                        if (versionMatch) {
                            legacyWrapperVersion = versionMatch[1];
                        }
                    }
                    try {
                        await fs.access(legacyBakPath);
                        legacyHasBak = true;
                    } catch {
                        legacyHasBak = false;
                    }
                    break;
                }
            } catch {
                // continue to next directory
            }
        }

        // Read extension version from package.json if available
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

        // Neither detected
        if (!agyExists && !legacyPath) {
            check.status = 'warning';
            check.message = 'Neither Antigravity IDE v2.6.0+ (~/.gemini/bin/agy) nor legacy language server found';
            check.suggestion = 'For Antigravity IDE v2.6.0+, ensure ~/.gemini/bin/agy exists (configure VS Code http.proxy for initial download). For legacy versions, ensure Antigravity extension is installed.';
            return check;
        }

        const messages: string[] = [];
        let hasError = false;
        let hasWarning = false;
        let hasSuccess = false;

        // Process v2.6.0+ agy status
        if (agyExists) {
            if (agyIsWrapper && agyHasBak) {
                hasSuccess = true;
                let msg = `v2.6.0+ (~/.gemini/bin/agy): wrapper and backup (.bak) properly configured (Wrapper v${agyWrapperVersion}, Extension v${extensionVersion})`;
                if (extensionVersion !== 'unknown' && agyWrapperVersion !== 'unknown' &&
                    agyWrapperVersion !== extensionVersion && extensionVersion !== '__EXTENSION_VERSION_PLACEHOLDER__') {
                    hasWarning = true;
                    msg += ' - Version mismatch, update recommended';
                }
                messages.push(msg);
            } else if (agyIsWrapper && !agyHasBak) {
                hasError = true;
                messages.push('v2.6.0+ (~/.gemini/bin/agy): wrapper is configured, but backup (agy.bak) is missing!');
            } else {
                hasWarning = true;
                messages.push('v2.6.0+ (~/.gemini/bin/agy): binary exists but is NOT wrapped with mgraftcp');
            }
        }

        // Process legacy status
        if (legacyPath) {
            const binaryName = path.basename(legacyPath);
            if (legacyIsWrapper && legacyHasBak) {
                hasSuccess = true;
                let msg = `legacy (${binaryName}): wrapper and backup (.bak) properly configured (Wrapper v${legacyWrapperVersion}, Extension v${extensionVersion})`;
                if (extensionVersion !== 'unknown' && legacyWrapperVersion !== 'unknown' &&
                    legacyWrapperVersion !== extensionVersion && extensionVersion !== '__EXTENSION_VERSION_PLACEHOLDER__') {
                    hasWarning = true;
                    msg += ' - Version mismatch, update recommended';
                }
                messages.push(msg);
            } else if (legacyIsWrapper && !legacyHasBak) {
                hasError = true;
                messages.push(`legacy (${binaryName}): wrapper is configured, but backup (${binaryName}.bak) is missing!`);
            } else {
                hasWarning = true;
                messages.push(`legacy (${binaryName}): binary exists but is NOT wrapped with mgraftcp`);
            }
        }

        check.message = messages.join('; ');

        if (hasError) {
            check.status = 'error';
            check.suggestion = 'Backup binary is missing. Please reinstall or restore the original binary before setting up proxy.';
        } else if (hasWarning && !hasSuccess) {
            check.status = 'warning';
            check.suggestion = 'Run "Setup Remote Environment" command to configure the wrapper.';
        } else if (hasWarning && hasSuccess) {
            check.status = 'warning';
            check.suggestion = 'Run "Setup Remote Environment" command to update the wrapper.';
        } else {
            check.status = 'success';
        }

    } catch (error) {
        const errorStr = String(error);
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
 * Detects if LS / agy is running, in persistent mode, and using proxy
 */
async function checkLanguageServerProcess(): Promise<DiagnosticCheck> {
    const check: DiagnosticCheck = {
        id: 'ls-process',
        name: 'Language Server Process',
        status: 'running'
    };

    try {
        const { stdout } = await execAsync("ps aux | grep -E '(language_server_linux|\\.gemini/bin/agy(\\.bak)?\\s+--hub)' | grep -v grep");
        const lines = stdout.trim().split('\n').filter(l => l.length > 0);

        if (lines.length === 0) {
            check.status = 'warning';
            check.message = 'Language Server / agy hub is not running';
            check.suggestion = 'This may be normal if you haven\'t used any AI features yet. The server starts on demand.';
            return check;
        }

        // Check if mgraftcp is wrapping the process in the process table
        const hasMgraftcpWrapper = lines.some(line => line.includes('mgraftcp'));
        
        // Find the actual binary process
        let isPersistent = false;
        let lsPid = 0;
        let isProxied = false;
        let processType = 'Language Server';

        // Prioritize v2.6.0+ (.gemini/bin/agy) over legacy language_server_linux if both exist
        const sortedLines = [...lines].sort((a, b) => {
            const aIsAgy = a.includes('.gemini/bin/agy') ? 0 : 1;
            const bIsAgy = b.includes('.gemini/bin/agy') ? 0 : 1;
            return aIsAgy - bIsAgy;
        });

        for (const line of sortedLines) {
            if (line.includes('mgraftcp-fakedns')) {
                continue; // Skip the wrapper process line
            }

            const isAgy = line.includes('.gemini/bin/agy') && line.includes('--hub');
            const isLegacy = line.includes('language_server_linux');

            if (isAgy || isLegacy) {
                const parts = line.split(/\s+/);
                if (parts.length >= 2) {
                    lsPid = parseInt(parts[1]);
                    processType = isAgy ? 'Antigravity IDE v2.6.0+ (agy --hub)' : 'Legacy Language Server';
                    isPersistent = isAgy || line.includes('--persistent_mode') || line.includes('persistent_mode');
                    // Accurately report whether running process is proxied (agy.bak / language_server_linux_*.bak / mgraftcp)
                    isProxied = line.includes('.bak') || line.includes('mgraftcp') || hasMgraftcpWrapper;
                    break;
                }
            }
        }

        // Build status message
        const modeLabel = isPersistent ? 'persistent mode' : 'normal mode';
        const proxyLabel = isProxied ? 'using proxy' : 'running directly without proxy';
        
        if (isProxied) {
            check.status = 'success';
            check.message = `${processType} (PID ${lsPid}) is running in ${modeLabel}, ${proxyLabel}`;
        } else if (isPersistent) {
            // Persistent mode but not using proxy - this is the bug scenario
            check.status = 'error';
            check.message = `${processType} (PID ${lsPid}) is running in ${modeLabel}, but ${proxyLabel}`;
            check.suggestion = `The process was started before the proxy wrapper was configured. ` +
                `Kill the process: Run "kill ${lsPid}" in terminal, then reload window.`;
        } else {
            // Non-persistent mode, not using proxy
            check.status = 'warning';
            check.message = `${processType} (PID ${lsPid}) is running in ${modeLabel}, but ${proxyLabel}`;
            check.suggestion = 'Reload the window to restart with proxy support.';
        }

    } catch {
        // grep returns non-zero if no match
        check.status = 'warning';
        check.message = 'Language Server / agy hub is not running';
        check.suggestion = 'This may be normal if you haven\'t used any AI features yet.';
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
        for (let i = 2; i < 7; i++) {
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
        updateCheck(6, await checkExternalConnectivity(remoteProxyHost, remoteProxyPort, proxyType));
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

