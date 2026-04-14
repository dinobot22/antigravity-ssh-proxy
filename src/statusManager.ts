import * as vscode from 'vscode';
import * as net from 'net';
import { runDiagnostics, DiagnosticCheck, DiagnosticReport, generateReportText, ProtocolTestResult } from './diagnostics/diagnosticRunner';
import { TrafficCollector, TrafficStats } from './traffic/trafficCollector';

export interface ProxyStatus {
    runningLocation: 'local' | 'remote';
    sshConfigEnabled: boolean;
    localProxyPort: number;
    remoteProxyPort: number;
    remoteProxyHost: string;
    localProxyReachable: boolean;
    remoteProxyReachable: boolean;
    lastUpdated: Date;
    languageServerConfigured?: boolean;
}

type StatusUpdateCallback = (status: ProxyStatus) => void;
type ConfigChangeCallback = () => Promise<void>;

const REFRESH_INTERVAL_SEC = 30;

// i18n translations
const i18n = {
    zh: {
        title: 'Antigravity SSH Proxy(ATP)',
        local: '本地',
        remote: '远程',
        connected: '已连接',
        partial: '部分连接',
        disconnected: '未连接',
        statusConfig: '状态与配置',
        sshForwarding: 'SSH 转发',
        localProxy: '本地代理',
        proxy: '代理状态',
        languageServer: '语言服务',
        reachable: '可达',
        unreachable: '不可达',
        on: '开启',
        off: '关闭',
        configured: '已配置',
        notConfigured: '未配置',
        enableForwarding: '启用转发',
        localPort: '本地端口',
        remotePort: '远程端口',
        proxyHost: '代理地址',
        proxyPort: '代理端口',
        proxyType: '代理类型',
        proxyTypeHttp: 'HTTP (推荐)',
        proxyTypeSocks5: 'SOCKS5',
        diagnostics: '诊断检查',
        runCheck: '运行检查',
        copyReport: '复制报告',
        running: '检测中...',
        localProxyService: '本地代理服务',
        sshConfig: 'SSH 配置',
        remoteForward: '远程端口转发',
        mgraftcp: 'mgraftcp-fakedns',
        lsWrapper: '语言服务包装',
        externalConn: '外部连接',
        localOnly: '仅本地可用',
        remoteOnly: '仅远程可用',
        traffic: '流量监控',
        connections: '连接',
        session: '会话时长',
        totalRequests: '总请求',
        tips: '使用提示',
        refresh: '刷新',
        rollback: '回滚',
        save: '保存',
        autoRefresh: '自动刷新',
        updated: '已更新',
        tunnelWarningTitle: 'SSH 隧道未建立',
        tunnelWarningMsg: '代理不可达。这通常发生在通过 Antigravity 的"最近连接"直接连接远程时。',
        tunnelStep1: '关闭此远程连接',
        tunnelStep2: '先打开一个本地窗口',
        tunnelStep3: '然后从本地窗口连接远程',
        closeRemote: '关闭远程连接',
        tipTitleLocal: '正确的连接流程',
        tipStep1Local: '在本地电脑启动代理软件（如 Clash、V2Ray）',
        tipStep2Local: '先打开一个本地 Antigravity 窗口 — 这会配置 SSH 隧道',
        tipStep3Local: '从本地窗口连接到远程服务器',
        tipStep4Local: '如有提示，重新加载远程窗口',
        tipNoteLocal: '不要通过 Antigravity 的"最近连接"直接连接远程！务必先打开本地窗口！',
        tipTitleRemote: '故障排除',
        tipStep1Remote: '如果代理不可达，说明 SSH 隧道未建立',
        tipStep2Remote: '关闭当前远程连接',
        tipStep3Remote: '先打开一个新的本地窗口（文件 → 新建窗口）',
        tipStep4Remote: '然后从本地窗口连接到远程服务器',
        tipNoteRemote: '这通常发生在你通过 Antigravity 的"最近连接"直接连接远程，而没有先打开本地窗口的情况下。',
        pending: '待检测',
        success: '通过',
        warning: '警告',
        error: '错误',
        skipped: '已跳过',
        reportCopied: '报告已复制到剪贴板',
        configSaved: '配置已保存',
        rollbackTitle: '回滚操作',
        rollbackDesc: '此功能用于恢复之前的语言服务配置。仅当您遇到插件升级导致的严重问题或在卸载插件前使用。',
        localPortTip: '💡 此端口需与本地代理软件（如 Clash、V2Ray）的监听端口一致，默认通常为 7890',
        remotePortTipLocal: '💡 此端口即 SSH 隧道在远端的监听端口，必须与远端 ATP 面板中「代理端口」的值保持一致',
        remotePortTipRemote: '💡 此端口即 SSH 隧道在远端的监听端口，必须与本地 ATP 面板中「远程端口」的值保持一致',
        codexTools: 'Codex 工具',
        syncCodexProfile: '同步本地 Codex Profile',
        restoreCodexProfile: '恢复远端 Codex Profile',
        rebucketCodexHistory: '合并 Codex 历史',
        restoreCodexHistory: '恢复 Codex 历史备份',
        codexToolsNote: 'Profile 同步依赖本地 ATP 的 Codex bridge；如果刚更新本地 ATP，通常需要断开并重新连接 SSH 才会带上新的转发端口。',
    },
    en: {
        title: 'Antigravity SSH Proxy(ATP)',
        local: 'Local',
        remote: 'Remote',
        connected: 'Connected',
        partial: 'Partial',
        disconnected: 'Disconnected',
        statusConfig: 'Status & Config',
        sshForwarding: 'SSH Forwarding',
        localProxy: 'Local Proxy',
        proxy: 'Proxy',
        languageServer: 'Language Server',
        reachable: 'Reachable',
        unreachable: 'Unreachable',
        on: 'ON',
        off: 'OFF',
        configured: 'Configured',
        notConfigured: 'Not Configured',
        enableForwarding: 'Enable Forwarding',
        localPort: 'Local Port',
        remotePort: 'Remote Port',
        proxyHost: 'Proxy Host',
        proxyPort: 'Proxy Port',
        proxyType: 'Proxy Type',
        proxyTypeHttp: 'HTTP (Recommended)',
        proxyTypeSocks5: 'SOCKS5',
        diagnostics: 'Diagnostics',
        runCheck: 'Run Check',
        copyReport: 'Copy Report',
        running: 'Running...',
        localProxyService: 'Local Proxy Service',
        sshConfig: 'SSH Configuration',
        remoteForward: 'Remote Port Forwarding',
        mgraftcp: 'mgraftcp-fakedns',
        lsWrapper: 'Language Server Wrapper',
        externalConn: 'External Connectivity',
        localOnly: 'Local only',
        remoteOnly: 'Remote only',
        traffic: 'Traffic Monitor',
        connections: 'connections',
        session: 'Session',
        totalRequests: 'Total Requests',
        tips: 'Tips',
        refresh: 'Refresh',
        rollback: 'Rollback',
        save: 'Save',
        autoRefresh: 'Auto refresh',
        updated: 'Updated',
        tunnelWarningTitle: 'SSH Tunnel Not Established',
        tunnelWarningMsg: 'Proxy is unreachable. This usually happens when you connect directly via Antigravity\'s recent connections.',
        tunnelStep1: 'Close this remote connection',
        tunnelStep2: 'Open a new local window first',
        tunnelStep3: 'Then connect to remote from the local window',
        closeRemote: 'Close Remote Connection',
        tipTitleLocal: 'Correct Connection Flow',
        tipStep1Local: 'Start your local proxy (e.g., Clash, V2Ray) on your computer',
        tipStep2Local: 'Open a local Antigravity window first — this configures SSH tunnel',
        tipStep3Local: 'Connect to remote server from the local window',
        tipStep4Local: 'Reload remote window if prompted',
        tipNoteLocal: 'Do NOT connect directly via Antigravity\'s recent connections. Always open a local window first!',
        tipTitleRemote: 'Troubleshooting',
        tipStep1Remote: 'If proxy is unreachable, the SSH tunnel was not established',
        tipStep2Remote: 'Close this remote connection',
        tipStep3Remote: 'Open a new local window first (File → New Window)',
        tipStep4Remote: 'Then connect to remote from the local window',
        tipNoteRemote: 'This usually happens when you connect directly via Antigravity\'s recent connections without opening a local window first.',
        pending: 'Pending',
        success: 'Pass',
        warning: 'Warning',
        error: 'Error',
        skipped: 'Skipped',
        reportCopied: 'Report copied to clipboard',
        configSaved: 'Configuration saved',
        rollbackTitle: 'Rollback Operation',
        rollbackDesc: 'Restores previous Language Server configuration. Use only if plugin update causes critical issues or before uninstalling.',
        localPortTip: '💡 Must match your local proxy software port (e.g., Clash, V2Ray). Default is usually 7890',
        remotePortTipLocal: '💡 This is the SSH tunnel port on the remote side. It must match the "Proxy Port" in the Remote ATP panel',
        remotePortTipRemote: '💡 This is the SSH tunnel port on the remote side. It must match the "Remote Port" in the Local ATP panel',
        codexTools: 'Codex Tools',
        syncCodexProfile: 'Sync Local Codex Profile',
        restoreCodexProfile: 'Restore Remote Codex Profile',
        rebucketCodexHistory: 'Rebucket Codex History',
        restoreCodexHistory: 'Restore Codex History Backup',
        codexToolsNote: 'Profile sync uses ATP\'s local Codex bridge. If you just updated local ATP, reconnect SSH so the extra bridge RemoteForward can take effect.',
    }
};

type Lang = 'zh' | 'en';

export class StatusManager {
    private statusBarItem: vscode.StatusBarItem;
    private currentStatus: ProxyStatus;
    private updateCallbacks: StatusUpdateCallback[] = [];
    private refreshInterval: NodeJS.Timeout | undefined;
    private statusPanel: vscode.WebviewPanel | undefined;
    private countdownInterval: NodeJS.Timeout | undefined;
    private secondsUntilRefresh: number = REFRESH_INTERVAL_SEC;
    private onConfigChange: ConfigChangeCallback | undefined;

    // New properties for unified dashboard
    private trafficCollector: TrafficCollector;
    private currentDiagnosticReport: DiagnosticReport | null = null;
    private isRunningDiagnostics: boolean = false;
    private currentLang: Lang = 'zh';

    constructor(private isLocal: boolean, private context: vscode.ExtensionContext) {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            -100
        );
        this.statusBarItem.command = 'antigravity-ssh-proxy.showStatusPanel';
        this.statusBarItem.name = 'ATP';

        const config = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
        this.currentStatus = {
            runningLocation: isLocal ? 'local' : 'remote',
            sshConfigEnabled: false,
            localProxyPort: config.get<number>('localProxyPort', 7890),
            remoteProxyPort: config.get<number>('remoteProxyPort', 7890),
            remoteProxyHost: config.get<string>('remoteProxyHost', '127.0.0.1'),
            localProxyReachable: false,
            remoteProxyReachable: false,
            lastUpdated: new Date(),
        };

        // Initialize traffic collector
        this.trafficCollector = new TrafficCollector();

        // Load saved language preference (default to Chinese)
        this.currentLang = this.context.globalState.get<Lang>('uiLanguage', 'zh');

        this.updateStatusBar();
        this.statusBarItem.show();
    }

    /**
     * Set config change callback for SSH config updates
     */
    setConfigChangeCallback(callback: ConfigChangeCallback): void {
        this.onConfigChange = callback;
    }

    onStatusUpdate(callback: StatusUpdateCallback): vscode.Disposable {
        this.updateCallbacks.push(callback);
        return new vscode.Disposable(() => {
            const index = this.updateCallbacks.indexOf(callback);
            if (index >= 0) {
                this.updateCallbacks.splice(index, 1);
            }
        });
    }

    startAutoRefresh(): void {
        this.stopAutoRefresh();
        this.secondsUntilRefresh = REFRESH_INTERVAL_SEC;

        this.refreshInterval = setInterval(() => {
            this.refreshStatus();
            this.secondsUntilRefresh = REFRESH_INTERVAL_SEC;
        }, REFRESH_INTERVAL_SEC * 1000);

        this.countdownInterval = setInterval(() => {
            this.secondsUntilRefresh = Math.max(0, this.secondsUntilRefresh - 1);
            this.updatePanelCountdown();
        }, 1000);

        this.refreshStatus();
    }

    stopAutoRefresh(): void {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = undefined;
        }
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
            this.countdownInterval = undefined;
        }
    }

    async refreshStatus(): Promise<void> {
        const config = vscode.workspace.getConfiguration('antigravity-ssh-proxy');

        this.currentStatus.localProxyPort = config.get<number>('localProxyPort', 7890);
        this.currentStatus.remoteProxyPort = config.get<number>('remoteProxyPort', 7890);
        this.currentStatus.remoteProxyHost = config.get<string>('remoteProxyHost', '127.0.0.1');

        if (this.isLocal) {
            this.currentStatus.localProxyReachable = await this.checkPort(
                '127.0.0.1',
                this.currentStatus.localProxyPort
            );
        } else {
            this.currentStatus.remoteProxyReachable = await this.checkPort(
                this.currentStatus.remoteProxyHost,
                this.currentStatus.remoteProxyPort
            );
        }

        this.currentStatus.lastUpdated = new Date();
        this.secondsUntilRefresh = REFRESH_INTERVAL_SEC;
        this.updateStatusBar();
        this.updatePanelIfOpen();
        this.notifyCallbacks();
    }

    updateSSHConfigStatus(enabled: boolean, port?: number): void {
        this.currentStatus.sshConfigEnabled = enabled;
        if (port !== undefined) {
            this.currentStatus.remoteProxyPort = port;
        }
        this.currentStatus.lastUpdated = new Date();
        this.updateStatusBar();
        this.updatePanelIfOpen();
        this.notifyCallbacks();
    }

    updateLanguageServerStatus(configured: boolean): void {
        this.currentStatus.languageServerConfigured = configured;
        this.currentStatus.lastUpdated = new Date();
        this.updateStatusBar();
        this.updatePanelIfOpen();
        this.notifyCallbacks();
    }

    getStatus(): ProxyStatus {
        return { ...this.currentStatus };
    }

    showStatusPanel(): void {
        if (this.statusPanel) {
            this.statusPanel.reveal();
            return;
        }

        this.statusPanel = vscode.window.createWebviewPanel(
            'atpStatus',
            'Antigravity SSH Proxy',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        // Start traffic collector when panel opens (remote only)
        if (!this.isLocal) {
            this.trafficCollector.start();
            this.trafficCollector.onUpdate(() => {
                this.updatePanelIfOpen();
            });
        }

        this.statusPanel.webview.html = this.getPanelHtml();

        this.statusPanel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'refresh':
                        await this.refreshStatus();
                        if (!this.isLocal) {
                            await this.trafficCollector.refresh();
                        }
                        // User explicitly refreshed: full rerender to reflect latest state
                        this.forceRenderPanel();
                        break;
                    case 'saveConfig':
                        await this.saveConfig(message.config);
                        // Full rerender so inputs show the confirmed saved values
                        this.forceRenderPanel();
                        break;
                    case 'runDiagnostics':
                        await this.runInlineDiagnostics();
                        break;
                    case 'copyReport':
                        await this.copyDiagnosticReport();
                        break;
                    case 'setLanguage':
                        this.currentLang = message.lang as Lang;
                        await this.context.globalState.update('uiLanguage', this.currentLang);
                        // Language change requires full rerender for all translated strings
                        this.forceRenderPanel();
                        break;
                    case 'closeRemote':
                        vscode.window.showInformationMessage(
                            'After closing: 1) Open a new local window  2) Connect to remote from there',
                            'Got it'
                        ).then(() => {
                            vscode.commands.executeCommand('workbench.action.remote.close');
                        });
                        break;
                    case 'rollback':
                        vscode.commands.executeCommand('antigravity-ssh-proxy.rollback');
                        break;
                    case 'syncCodexProfile':
                        vscode.commands.executeCommand('antigravity-ssh-proxy.syncCodexProfile');
                        break;
                    case 'restoreCodexProfile':
                        vscode.commands.executeCommand('antigravity-ssh-proxy.restoreCodexProfile');
                        break;
                    case 'rebucketCodexHistory':
                        vscode.commands.executeCommand('antigravity-ssh-proxy.rebucketCodexHistory');
                        break;
                    case 'restoreCodexHistory':
                        vscode.commands.executeCommand('antigravity-ssh-proxy.restoreCodexHistory');
                        break;
                }
            },
            undefined,
            this.context.subscriptions
        );

        this.statusPanel.onDidDispose(() => {
            this.statusPanel = undefined;
            if (!this.isLocal) {
                this.trafficCollector.stop();
            }
        });
    }

    /**
     * Run diagnostics inline and update panel
     */
    private async runInlineDiagnostics(): Promise<void> {
        if (this.isRunningDiagnostics) {
            return;
        }

        this.isRunningDiagnostics = true;
        // Full rerender to show "running..." button state (user-triggered)
        this.forceRenderPanel();

        try {
            this.currentDiagnosticReport = await runDiagnostics((checks) => {
                // Update panel with progress
                if (this.statusPanel) {
                    this.statusPanel.webview.postMessage({
                        command: 'diagnosticProgress',
                        checks: checks
                    });
                }
            }, this.context.extensionUri.fsPath);
        } finally {
            this.isRunningDiagnostics = false;
            // Full rerender to show diagnostic results
            this.forceRenderPanel();
        }
    }

    /**
     * Copy diagnostic report to clipboard
     */
    private async copyDiagnosticReport(): Promise<void> {
        if (this.currentDiagnosticReport) {
            const text = generateReportText(this.currentDiagnosticReport);
            await vscode.env.clipboard.writeText(text);
            const t = i18n[this.currentLang];
            vscode.window.showInformationMessage(t.reportCopied);
        }
    }

    /**
     * Save configuration
     */
    private async saveConfig(newConfig: {
        localProxyPort?: number;
        remoteProxyPort?: number;
        remoteProxyHost?: string;
        enableLocalForwarding?: boolean;
        proxyType?: string;
    }): Promise<void> {
        const config = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
        const oldProxyType = config.get<string>('proxyType', 'http');
        const t = i18n[this.currentLang];

        try {
            if (newConfig.localProxyPort !== undefined) {
                await config.update('localProxyPort', newConfig.localProxyPort, vscode.ConfigurationTarget.Global);
            }
            if (newConfig.remoteProxyPort !== undefined) {
                await config.update('remoteProxyPort', newConfig.remoteProxyPort, vscode.ConfigurationTarget.Global);
            }
            if (newConfig.remoteProxyHost !== undefined) {
                await config.update('remoteProxyHost', newConfig.remoteProxyHost, vscode.ConfigurationTarget.Global);
            }
            if (newConfig.enableLocalForwarding !== undefined) {
                await config.update('enableLocalForwarding', newConfig.enableLocalForwarding, vscode.ConfigurationTarget.Global);
            }
            if (newConfig.proxyType !== undefined) {
                await config.update('proxyType', newConfig.proxyType, vscode.ConfigurationTarget.Global);
            }

            // Trigger config change callback
            if (this.onConfigChange) {
                await this.onConfigChange();
            }

            await this.refreshStatus();

            // If proxyType changed, prompt for reload
            if (newConfig.proxyType !== undefined && newConfig.proxyType !== oldProxyType) {
                const reloadMsg = this.currentLang === 'zh'
                    ? `代理类型已更改为 ${newConfig.proxyType.toUpperCase()}。请重新加载窗口以应用更改。`
                    : `Proxy type changed to ${newConfig.proxyType.toUpperCase()}. Please reload window to apply changes.`;
                const reloadNow = this.currentLang === 'zh' ? '立即重载' : 'Reload Now';
                const later = this.currentLang === 'zh' ? '稍后' : 'Later';

                vscode.window.showInformationMessage(reloadMsg, reloadNow, later).then(selection => {
                    if (selection === reloadNow) {
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                });
            } else {
                vscode.window.showInformationMessage(t.configSaved);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to save config: ${error}`);
        }
    }

    private updatePanelIfOpen(): void {
        if (!this.statusPanel) { return; }

        const status = this.currentStatus;
        const isLocal = status.runningLocation === 'local';
        const config = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
        const t = i18n[this.currentLang];
        const trafficStats = this.trafficCollector.getStats();

        let statusColor: string;
        let statusText: string;
        if (isLocal) {
            if (status.sshConfigEnabled && status.localProxyReachable) {
                statusColor = '#22c55e'; statusText = t.connected;
            } else if (status.sshConfigEnabled) {
                statusColor = '#eab308'; statusText = t.partial;
            } else {
                statusColor = '#ef4444'; statusText = t.disconnected;
            }
        } else {
            statusColor = status.remoteProxyReachable ? '#22c55e' : '#ef4444';
            statusText = status.remoteProxyReachable ? t.connected : t.disconnected;
        }

        this.statusPanel.webview.postMessage({
            command: 'updateStatus',
            statusColor,
            statusText,
            sshConfigEnabled: status.sshConfigEnabled,
            localProxyReachable: status.localProxyReachable,
            remoteProxyReachable: status.remoteProxyReachable,
            remoteProxyHost: status.remoteProxyHost,
            languageServerConfigured: status.languageServerConfigured,
            lastUpdated: status.lastUpdated.toLocaleTimeString(),
            trafficHtml: this.generateTrafficHtml(t, trafficStats, isLocal),
            t: {
                on: t.on, off: t.off,
                reachable: t.reachable, unreachable: t.unreachable,
                configured: t.configured, notConfigured: t.notConfigured,
                updated: t.updated,
            }
        });
    }

    private forceRenderPanel(): void {
        if (this.statusPanel) {
            this.statusPanel.webview.html = this.getPanelHtml();
        }
    }

    private updatePanelCountdown(): void {
        if (this.statusPanel) {
            this.statusPanel.webview.postMessage({
                command: 'updateCountdown',
                seconds: this.secondsUntilRefresh
            });
        }
    }

    private updateStatusBar(): void {
        const status = this.currentStatus;
        let tooltip: string;

        if (this.isLocal) {
            if (status.sshConfigEnabled && status.localProxyReachable) {
                this.statusBarItem.color = '#22c55e';
                tooltip = 'Antigravity SSH Proxy (ATP)\n✅ Connected';
            } else if (status.sshConfigEnabled) {
                this.statusBarItem.color = '#eab308';
                tooltip = 'Antigravity SSH Proxy (ATP)\n⚠️ SSH configured, proxy unreachable';
            } else {
                this.statusBarItem.color = '#ef4444';
                tooltip = 'Antigravity SSH Proxy (ATP)\n❌ Disconnected';
            }
        } else {
            if (status.remoteProxyReachable) {
                this.statusBarItem.color = '#22c55e';
                tooltip = 'Antigravity SSH Proxy (ATP)\n✅ Proxy OK';
            } else {
                this.statusBarItem.color = '#ef4444';
                tooltip = 'Antigravity SSH Proxy (ATP)\n❌ Proxy unreachable';
            }
        }

        this.statusBarItem.text = '$(circle-large-filled) ATP';
        this.statusBarItem.tooltip = tooltip;
        this.statusBarItem.backgroundColor = undefined;
    }

    private checkPort(host: string, port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const socket = new net.Socket();
            socket.setTimeout(2000);
            socket.on('connect', () => { socket.destroy(); resolve(true); });
            socket.on('timeout', () => { socket.destroy(); resolve(false); });
            socket.on('error', () => { socket.destroy(); resolve(false); });
            socket.connect(port, host);
        });
    }

    private notifyCallbacks(): void {
        const status = this.getStatus();
        for (const callback of this.updateCallbacks) {
            callback(status);
        }
    }

    private getDiagnosticCheckName(id: string, t: typeof i18n.zh): string {
        const names: Record<string, string> = {
            'local-proxy': t.localProxyService,
            'ssh-config': t.sshConfig,
            'remote-forward': t.remoteForward,
            'mgraftcp': t.mgraftcp,
            'ls-wrapper': t.lsWrapper,
            'external-connectivity': t.externalConn,
        };
        return names[id] || id;
    }

    private getPanelHtml(): string {
        const status = this.currentStatus;
        const isLocal = status.runningLocation === 'local';
        const config = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
        const enableForwarding = config.get<boolean>('enableLocalForwarding', true);
        const proxyType = config.get<string>('proxyType', 'http');
        const t = i18n[this.currentLang];
        const trafficStats = this.trafficCollector.getStats();

        let statusColor: string;
        let statusText: string;

        if (isLocal) {
            if (status.sshConfigEnabled && status.localProxyReachable) {
                statusColor = '#22c55e';
                statusText = t.connected;
            } else if (status.sshConfigEnabled) {
                statusColor = '#eab308';
                statusText = t.partial;
            } else {
                statusColor = '#ef4444';
                statusText = t.disconnected;
            }
        } else {
            statusColor = status.remoteProxyReachable ? '#22c55e' : '#ef4444';
            statusText = status.remoteProxyReachable ? t.connected : t.disconnected;
        }

        // Generate diagnostics HTML
        const diagnosticsHtml = this.generateDiagnosticsHtml(t, isLocal);

        // Generate traffic HTML (remote only)
        const trafficHtml = this.generateTrafficHtml(t, trafficStats, isLocal);

        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        :root {
            --bg-primary: #0d0d0d;
            --bg-card: #1a1a1a;
            --border-color: #252525;
            --text-primary: #f0f0f0;
            --text-secondary: #666;
            --text-muted: #444;
            --accent: #888;
            --success: #22c55e;
            --error: #ef4444;
            --warning: #eab308;
        }
        
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: 'JetBrains Mono', 'SF Mono', 'Fira Code', 'Consolas', monospace;
            background: var(--bg-primary);
            color: var(--text-primary);
            padding: 24px;
            font-size: 12px;
            line-height: 1.5;
        }
        
        .container {
            max-width: 720px;
            margin: 0 auto;
        }
        
        /* Header */
        .header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 24px;
            padding-bottom: 20px;
            border-bottom: 1px solid var(--border-color);
        }
        
        .status-indicator {
            width: 8px;
            height: 8px;
            border-radius: 2px;
            background: ${statusColor};
            box-shadow: 0 0 12px ${statusColor}60;
        }
        
        .title {
            font-size: 14px;
            font-weight: 700;
            letter-spacing: 0.5px;
            text-transform: uppercase;
        }
        
        .env-badge {
            font-size: 9px;
            font-weight: 600;
            padding: 3px 8px;
            border-radius: 2px;
            background: var(--border-color);
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .status-badge {
            margin-left: auto;
            font-size: 10px;
            font-weight: 600;
            padding: 4px 10px;
            border-radius: 2px;
            background: ${statusColor}15;
            color: ${statusColor};
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .lang-toggle {
            display: flex;
            align-items: center;
            gap: 0;
            margin-left: 12px;
        }
        
        .lang-btn {
            padding: 4px 8px;
            font-size: 10px;
            font-weight: 600;
            background: transparent;
            border: 1px solid var(--border-color);
            color: var(--text-secondary);
            cursor: pointer;
            transition: all 0.15s;
            font-family: inherit;
        }
        
        .lang-btn:first-child {
            border-radius: 2px 0 0 2px;
        }
        
        .lang-btn:last-child {
            border-radius: 0 2px 2px 0;
            border-left: none;
        }
        
        .lang-btn.active {
            background: var(--text-primary);
            color: var(--bg-primary);
            border-color: var(--text-primary);
        }
        
        /* Grid Layout */
        .grid {
            display: grid;
            grid-template-columns: 1fr 200px;
            gap: 16px;
            margin-bottom: 16px;
        }
        
        .grid-full {
            grid-column: 1 / -1;
        }
        
        @media (max-width: 600px) {
            .grid {
                grid-template-columns: 1fr;
            }
        }
        
        /* Cards */
        .card {
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            overflow: hidden;
        }
        
        .card-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 16px;
            border-bottom: 1px solid var(--border-color);
            background: var(--bg-primary);
        }
        
        .card-title {
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 1px;
            color: var(--text-secondary);
        }
        
        .card-title-icon {
            margin-right: 8px;
            opacity: 0.7;
        }
        
        .card-body {
            padding: 12px 16px;
        }
        
        /* Rows */
        .row {
            display: flex;
            align-items: center;
            padding: 8px 0;
            border-bottom: 1px solid var(--border-color);
        }
        
        .row:last-child {
            border-bottom: none;
        }
        
        .row-label {
            flex: 1;
            color: var(--text-secondary);
            font-size: 11px;
        }
        
        .row-value {
            font-weight: 600;
            font-size: 11px;
        }
        
        .row-value.success { color: var(--success); }
        .row-value.error { color: var(--error); }
        .row-value.warning { color: var(--warning); }
        .row-value.muted { color: var(--text-muted); }
        
        .row-extra {
            margin-left: 12px;
            color: var(--text-muted);
            font-size: 10px;
            font-family: 'JetBrains Mono', monospace;
        }
        
        /* Input Rows */
        .input-row {
            display: flex;
            align-items: center;
            padding: 8px 0;
            border-bottom: 1px solid var(--border-color);
            gap: 12px;
        }
        
        .input-row:last-child {
            border-bottom: none;
        }
        
        .input-row label {
            flex: 1;
            color: var(--text-secondary);
            font-size: 11px;
        }
        
        .input-row label.toggle {
            flex: none;
        }
        
        .input-row input[type="text"],
        .input-row input[type="number"] {
            width: 100px;
            padding: 6px 10px;
            border: 1px solid var(--border-color);
            border-radius: 2px;
            background: var(--bg-primary);
            color: var(--text-primary);
            font-family: inherit;
            font-size: 11px;
        }
        
        .input-row input:focus {
            outline: none;
            border-color: var(--accent);
        }
        
        .input-row select {
            width: 100px;
            padding: 6px 10px;
            border: 1px solid var(--border-color);
            border-radius: 2px;
            background: var(--bg-primary);
            color: var(--text-primary);
            font-family: inherit;
            font-size: 11px;
            cursor: pointer;
        }
        
        .input-row select:focus {
            outline: none;
            border-color: var(--accent);
        }
        
        /* Toggle Switch */
        .toggle {
            position: relative;
            width: 32px;
            height: 16px;
            flex: none;
        }
        
        .toggle input {
            opacity: 0;
            width: 0;
            height: 0;
        }
        
        .toggle-slider {
            position: absolute;
            cursor: pointer;
            inset: 0;
            background: var(--bg-primary);
            border: 1px solid var(--border-color);
            border-radius: 2px;
            transition: 0.2s;
        }
        
        .toggle-slider:before {
            position: absolute;
            content: "";
            height: 10px;
            width: 10px;
            left: 2px;
            bottom: 2px;
            background: var(--text-secondary);
            border-radius: 1px;
            transition: 0.2s;
        }
        
        .toggle input:checked + .toggle-slider {
            background: var(--success);
            border-color: var(--success);
        }
        
        .toggle input:checked + .toggle-slider:before {
            transform: translateX(16px);
            background: var(--bg-primary);
        }
        
        /* Warning Alert */
        .alert {
            display: flex;
            gap: 16px;
            padding: 16px;
            border-radius: 4px;
            border: 1px solid;
            margin-bottom: 16px;
        }
        
        .alert-warning {
            background: ${statusColor}08;
            border-color: ${statusColor}40;
        }
        
        .alert-icon {
            font-size: 18px;
            flex-shrink: 0;
        }
        
        .alert-content {
            flex: 1;
        }
        
        .alert-title {
            font-weight: 700;
            font-size: 12px;
            color: var(--warning);
            margin-bottom: 8px;
        }
        
        .alert-message {
            font-size: 11px;
            color: var(--text-secondary);
            margin-bottom: 12px;
            line-height: 1.6;
        }
        
        .alert-steps {
            display: flex;
            flex-direction: column;
            gap: 6px;
            margin-bottom: 16px;
        }
        
        .alert-step {
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 11px;
            color: var(--text-secondary);
        }
        
        .step-num {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 18px;
            height: 18px;
            border-radius: 2px;
            background: var(--warning);
            color: var(--bg-primary);
            font-size: 10px;
            font-weight: 700;
        }
        
        /* Diagnostics */
        .diag-item {
            display: flex;
            align-items: center;
            padding: 6px 0;
            gap: 10px;
        }
        
        .diag-dot {
            width: 6px;
            height: 6px;
            border-radius: 1px;
            flex-shrink: 0;
        }
        
        .diag-dot.pending { background: var(--text-muted); }
        .diag-dot.running { background: var(--warning); animation: pulse 1s infinite; }
        .diag-dot.success { background: var(--success); }
        .diag-dot.warning { background: var(--warning); }
        .diag-dot.error { background: var(--error); }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.4; }
        }
        
        .diag-name {
            flex: 1;
            font-size: 11px;
            color: var(--text-secondary);
        }
        
        .diag-name.disabled {
            color: var(--text-muted);
        }
        
        .diag-status {
            font-size: 10px;
            color: var(--text-muted);
        }
        
        .diag-status.success { color: var(--success); }
        .diag-status.error { color: var(--error); }
        .diag-status.warning { color: var(--warning); }
        
        .diag-item-wrapper {
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 8px;
            margin-bottom: 8px;
        }
        
        .diag-item-wrapper:last-child {
            border-bottom: none;
            padding-bottom: 0;
            margin-bottom: 0;
        }
        
        .diag-details {
            margin-left: 16px;
            margin-top: 4px;
            padding-left: 10px;
            border-left: 2px solid var(--border-color);
        }
        
        .diag-message {
            font-size: 10px;
            color: var(--text-secondary);
            line-height: 1.4;
            margin-bottom: 4px;
        }
        
        .diag-suggestion {
            font-size: 10px;
            color: var(--warning);
            line-height: 1.4;
            font-style: italic;
        }
        
        /* Protocol List for External Connectivity */
        .protocol-list {
            margin-bottom: 6px;
        }
        
        .protocol-item {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 10px;
            line-height: 1.8;
        }
        
        .protocol-prefix {
            color: var(--text-muted);
            font-family: monospace;
        }
        
        .protocol-name {
            color: var(--text-secondary);
            min-width: 55px;
        }
        
        .protocol-status {
            font-weight: 600;
        }
        
        .protocol-status.success { color: var(--success); }
        .protocol-status.error { color: var(--error); }
        
        .protocol-current {
            color: var(--text-muted);
            font-style: italic;
        }
        /* Traffic Monitor */
        .traffic-stat {
            padding: 8px 0;
            border-bottom: 1px solid var(--border-color);
        }
        
        .traffic-stat:last-child {
            border-bottom: none;
        }
        
        .traffic-label {
            font-size: 9px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--text-muted);
            margin-bottom: 4px;
        }
        
        .traffic-value {
            font-size: 18px;
            font-weight: 700;
            color: var(--text-primary);
        }
        
        .traffic-value.small {
            font-size: 12px;
        }
        
        .traffic-bar {
            display: flex;
            height: 4px;
            background: var(--bg-primary);
            border-radius: 2px;
            overflow: hidden;
            margin-top: 8px;
        }
        
        .traffic-bar-fill {
            background: var(--success);
            transition: width 0.3s;
        }
        
        .traffic-unavailable {
            color: var(--text-muted);
            font-size: 10px;
            text-align: center;
            padding: 20px;
        }
        
        /* Tips Card */
        .tip-content {
            font-size: 11px;
            color: var(--text-secondary);
            line-height: 1.7;
        }
        
        .tip-title {
            font-weight: 700;
            color: var(--text-primary);
            margin-bottom: 12px;
            font-size: 12px;
        }
        
        .tip-steps {
            list-style: none;
            padding: 0;
            margin: 0;
        }
        
        .tip-step {
            display: flex;
            align-items: flex-start;
            gap: 10px;
            margin-bottom: 8px;
        }
        
        .tip-step .step-num {
            background: var(--border-color);
            color: var(--text-secondary);
            margin-top: 2px;
        }
        
        .tip-note {
            margin-top: 16px;
            padding-top: 12px;
            border-top: 1px dashed var(--border-color);
            font-size: 10px;
            color: var(--text-muted);
        }
        
        .tip-note strong {
            color: var(--warning);
        }
        
        /* Buttons */
        .actions {
            display: flex;
            gap: 8px;
            margin-top: 16px;
        }
        
        .btn {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            padding: 10px 16px;
            border: 1px solid var(--border-color);
            border-radius: 2px;
            background: var(--bg-card);
            color: var(--text-primary);
            font-size: 10px;
            font-weight: 600;
            font-family: inherit;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            cursor: pointer;
            transition: all 0.15s;
        }
        
        .btn:hover {
            background: var(--border-color);
        }
        
        .btn-primary {
            background: var(--text-primary);
            color: var(--bg-primary);
            border-color: var(--text-primary);
        }
        
        .btn-primary:hover {
            background: var(--text-secondary);
            border-color: var(--text-secondary);
        }
        
        .btn-warning {
            background: var(--warning);
            color: var(--bg-primary);
            border-color: var(--warning);
        }
        
        .btn-warning:hover {
            opacity: 0.9;
        }
        
        .btn-sm {
            flex: none;
            padding: 6px 12px;
            font-size: 9px;
        }
        
        /* Input field tip */
        .input-tip {
            font-size: 9.5px;
            color: var(--warning);
            margin-top: 3px;
            margin-bottom: 2px;
            line-height: 1.4;
            opacity: 0.85;
        }
        
        /* Footer */
        .footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-top: 20px;
            padding-top: 16px;
            border-top: 1px solid var(--border-color);
            font-size: 10px;
            color: var(--text-muted);
        }
        
        .countdown-num {
            font-weight: 600;
            color: var(--text-secondary);
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- Header -->
        <div class="header">
            <div class="status-indicator" id="status-dot"></div>
            <span class="title">${t.title}</span>
            <span class="env-badge">${isLocal ? t.local : t.remote}</span>
            <span class="status-badge" id="status-badge-text">${statusText}</span>
            <div class="lang-toggle">
                <button class="lang-btn ${this.currentLang === 'zh' ? 'active' : ''}" onclick="setLang('zh')">中</button>
                <button class="lang-btn ${this.currentLang === 'en' ? 'active' : ''}" onclick="setLang('en')">EN</button>
            </div>
        </div>
        
        ${!isLocal ? `
        <!-- Warning Alert: always in DOM for remote mode, visibility controlled by JS -->
        <div id="tunnel-alert" class="alert alert-warning" style="${!status.remoteProxyReachable ? '' : 'display:none;'}">
            <div class="alert-icon">⚠</div>
            <div class="alert-content">
                <div class="alert-title">${t.tunnelWarningTitle}</div>
                <div class="alert-message">${t.tunnelWarningMsg}</div>
                <div class="alert-steps">
                    <div class="alert-step"><span class="step-num">1</span>${t.tunnelStep1}</div>
                    <div class="alert-step"><span class="step-num">2</span>${t.tunnelStep2}</div>
                    <div class="alert-step"><span class="step-num">3</span>${t.tunnelStep3}</div>
                </div>
                <button class="btn btn-warning" onclick="closeRemote()">${t.closeRemote}</button>
            </div>
        </div>
        ` : ''}
        
        <!-- Status & Config Card -->
        <div class="card" style="margin-bottom: 16px;">
            <div class="card-header">
                <span class="card-title"><span class="card-title-icon">⚡</span>${t.statusConfig}</span>
            </div>
            <div class="card-body">
                ${isLocal ? `
                <div class="row">
                    <span class="row-label">${t.sshForwarding}</span>
                    <span id="ssh-fwd-val" class="row-value ${status.sshConfigEnabled ? 'success' : 'error'}">${status.sshConfigEnabled ? t.on : t.off}</span>
                </div>
                <div class="row">
                    <span class="row-label">${t.localProxy}</span>
                    <span id="local-proxy-val" class="row-value ${status.localProxyReachable ? 'success' : 'error'}">${status.localProxyReachable ? t.reachable : t.unreachable}</span>
                </div>
                <div class="input-row">
                    <label>${t.enableForwarding}</label>
                    <label class="toggle">
                        <input type="checkbox" id="enableForwarding" ${enableForwarding ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                <div class="input-row">
                    <label>${t.localPort}</label>
                    <input type="number" id="localProxyPort" value="${status.localProxyPort}" min="1" max="65535">
                </div>
                <div class="input-tip">${t.localPortTip}</div>
                <div class="input-row">
                    <label>${t.remotePort}</label>
                    <input type="number" id="remoteProxyPort" value="${status.remoteProxyPort}" min="1" max="65535">
                </div>
                <div class="input-tip">${t.remotePortTipLocal}</div>
                ` : `
                <div class="row">
                    <span class="row-label">${t.proxy}</span>
                    <span id="remote-proxy-val" class="row-value ${status.remoteProxyReachable ? 'success' : 'error'}">${status.remoteProxyReachable ? t.reachable : t.unreachable}</span>
                    <span id="remote-proxy-host-extra" class="row-extra">${status.remoteProxyHost}</span>
                </div>
                <div id="lang-server-row" class="row" style="${status.languageServerConfigured !== undefined ? '' : 'display:none;'}">
                    <span class="row-label">${t.languageServer}</span>
                    <span id="lang-server-val" class="row-value ${status.languageServerConfigured ? 'success' : 'error'}">${status.languageServerConfigured !== undefined ? (status.languageServerConfigured ? t.configured : t.notConfigured) : ''}</span>
                </div>
                <div class="input-row">
                    <label>${t.proxyHost}</label>
                    <input type="text" id="remoteProxyHost" value="${status.remoteProxyHost}">
                </div>
                <div class="input-row">
                    <label>${t.proxyPort}</label>
                    <input type="number" id="remoteProxyPort" value="${status.remoteProxyPort}" min="1" max="65535">
                </div>
                <div class="input-tip">${t.remotePortTipRemote}</div>
                <div class="input-row">
                    <label>${t.proxyType}</label>
                    <select id="proxyType">
                        <option value="http" ${proxyType === 'http' ? 'selected' : ''}>${t.proxyTypeHttp}</option>
                        <option value="socks5" ${proxyType === 'socks5' ? 'selected' : ''}>${t.proxyTypeSocks5}</option>
                    </select>
                </div>
                `}
            </div>
        </div>
        
        <!-- Diagnostics Card -->
        <div class="card" style="margin-bottom: 16px;">
            <div class="card-header">
                <span class="card-title"><span class="card-title-icon">◎</span>${t.diagnostics}</span>
                <div style="display: flex; gap: 6px;">
                    <button class="btn btn-sm" onclick="runDiagnostics()" ${this.isRunningDiagnostics ? 'disabled' : ''}>
                        ${this.isRunningDiagnostics ? t.running : t.runCheck}
                    </button>
                    <button class="btn btn-sm" onclick="copyReport()" ${!this.currentDiagnosticReport ? 'disabled' : ''}>
                        ${t.copyReport}
                    </button>
                </div>
            </div>
            <div class="card-body">
                ${diagnosticsHtml}
            </div>
        </div>
        
        ${!isLocal ? `
        <div class="card" style="margin-bottom: 16px;">
            <div class="card-header">
                <span class="card-title"><span class="card-title-icon">⌘</span>${t.codexTools}</span>
            </div>
            <div class="card-body">
                <div class="actions" style="margin-top: 0;">
                    <button class="btn" onclick="syncCodexProfile()">${t.syncCodexProfile}</button>
                    <button class="btn" onclick="restoreCodexProfile()">${t.restoreCodexProfile}</button>
                    <button class="btn" onclick="rebucketCodexHistory()">${t.rebucketCodexHistory}</button>
                    <button class="btn" onclick="restoreCodexHistory()">${t.restoreCodexHistory}</button>
                </div>
                <div class="tip-note" style="margin-top: 10px;">${t.codexToolsNote}</div>
            </div>
        </div>
        ` : ''}

        <!-- Tips & Traffic Grid -->
        <div class="grid">
            <!-- Tips Card -->
            <div class="card">
                <div class="card-header">
                    <span class="card-title"><span class="card-title-icon">◇</span>${t.tips}</span>
                </div>
                <div class="card-body">
                    <div class="tip-content">
                        ${isLocal ? `
                        <div class="tip-title">${t.tipTitleLocal}</div>
                        <ul class="tip-steps">
                            <li class="tip-step"><span class="step-num">1</span><span>${t.tipStep1Local}</span></li>
                            <li class="tip-step"><span class="step-num">2</span><span>${t.tipStep2Local}</span></li>
                            <li class="tip-step"><span class="step-num">3</span><span>${t.tipStep3Local}</span></li>
                            <li class="tip-step"><span class="step-num">4</span><span>${t.tipStep4Local}</span></li>
                        </ul>
                        <div class="tip-note"><strong>⚠</strong> ${t.tipNoteLocal}</div>
                        ` : `
                        <div class="tip-title">${t.tipTitleRemote}</div>
                        <ul class="tip-steps">
                            <li class="tip-step"><span class="step-num">1</span><span>${t.tipStep1Remote}</span></li>
                            <li class="tip-step"><span class="step-num">2</span><span>${t.tipStep2Remote}</span></li>
                            <li class="tip-step"><span class="step-num">3</span><span>${t.tipStep3Remote}</span></li>
                            <li class="tip-step"><span class="step-num">4</span><span>${t.tipStep4Remote}</span></li>
                        </ul>
                        <div class="tip-note">${t.tipNoteRemote}</div>
                        <div style="margin-top: 12px; padding-top: 8px; border-top: 1px dashed var(--border-color);">
                            <div class="tip-title" style="color: var(--error); margin-bottom: 4px;">${t.rollbackTitle}</div>
                            <div style="font-size: 10px; color: var(--text-muted);">${t.rollbackDesc}</div>
                        </div>
                        `}
                    </div>
                </div>
            </div>
            
            <!-- Traffic Card -->
            <div id="traffic-container">${trafficHtml}</div>
        </div>
        
        <!-- Actions -->
        <div class="actions">
            <button class="btn" onclick="rollback()">${t.rollback}</button>
            <button class="btn" onclick="refresh()">${t.refresh}</button>
            <button class="btn btn-primary" onclick="saveConfig()">${t.save}</button>
        </div>
        
        <!-- Footer -->
        <div class="footer">
            <span>${t.autoRefresh}: <span class="countdown-num" id="countdown">${this.secondsUntilRefresh}</span>s</span>
            <span id="last-updated">${t.updated} ${status.lastUpdated.toLocaleTimeString()}</span>
        </div>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        const isLocal = ${isLocal};
        
        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }
        
        function rollback() {
            vscode.postMessage({ command: 'rollback' });
        }

        function syncCodexProfile() {
            vscode.postMessage({ command: 'syncCodexProfile' });
        }

        function restoreCodexProfile() {
            vscode.postMessage({ command: 'restoreCodexProfile' });
        }

        function rebucketCodexHistory() {
            vscode.postMessage({ command: 'rebucketCodexHistory' });
        }

        function restoreCodexHistory() {
            vscode.postMessage({ command: 'restoreCodexHistory' });
        }
        
        function saveConfig() {
            const config = {};
            if (isLocal) {
                config.enableLocalForwarding = document.getElementById('enableForwarding').checked;
                config.localProxyPort = parseInt(document.getElementById('localProxyPort').value);
                config.remoteProxyPort = parseInt(document.getElementById('remoteProxyPort').value);
            } else {
                config.remoteProxyHost = document.getElementById('remoteProxyHost').value;
                config.remoteProxyPort = parseInt(document.getElementById('remoteProxyPort').value);
                config.proxyType = document.getElementById('proxyType').value;
            }
            vscode.postMessage({ command: 'saveConfig', config });
        }
        
        function runDiagnostics() {
            vscode.postMessage({ command: 'runDiagnostics' });
        }
        
        function copyReport() {
            vscode.postMessage({ command: 'copyReport' });
        }
        
        function setLang(lang) {
            vscode.postMessage({ command: 'setLanguage', lang });
        }
        
        function closeRemote() {
            vscode.postMessage({ command: 'closeRemote' });
        }
        
        window.addEventListener('message', event => {
            const message = event.data;

            if (message.command === 'updateCountdown') {
                const el = document.getElementById('countdown');
                if (el) el.textContent = message.seconds;
            }

            if (message.command === 'updateStatus') {
                const m = message;

                // --- Status indicator dot ---
                const dot = document.getElementById('status-dot');
                if (dot) {
                    dot.style.background = m.statusColor;
                    dot.style.boxShadow = '0 0 12px ' + m.statusColor + '60';
                }

                // --- Status badge ---
                const badge = document.getElementById('status-badge-text');
                if (badge) {
                    badge.textContent = m.statusText;
                    badge.style.color = m.statusColor;
                    badge.style.background = m.statusColor + '15';
                }

                if (isLocal) {
                    // SSH forwarding value
                    const sshVal = document.getElementById('ssh-fwd-val');
                    if (sshVal) {
                        sshVal.textContent = m.sshConfigEnabled ? m.t.on : m.t.off;
                        sshVal.className = 'row-value ' + (m.sshConfigEnabled ? 'success' : 'error');
                    }
                    // Local proxy reachability
                    const localVal = document.getElementById('local-proxy-val');
                    if (localVal) {
                        localVal.textContent = m.localProxyReachable ? m.t.reachable : m.t.unreachable;
                        localVal.className = 'row-value ' + (m.localProxyReachable ? 'success' : 'error');
                    }
                } else {
                    // Remote proxy reachability
                    const remoteVal = document.getElementById('remote-proxy-val');
                    if (remoteVal) {
                        remoteVal.textContent = m.remoteProxyReachable ? m.t.reachable : m.t.unreachable;
                        remoteVal.className = 'row-value ' + (m.remoteProxyReachable ? 'success' : 'error');
                    }
                    const remoteHost = document.getElementById('remote-proxy-host-extra');
                    if (remoteHost) { remoteHost.textContent = m.remoteProxyHost; }

                    // Language server row
                    const lsRow = document.getElementById('lang-server-row');
                    if (lsRow) {
                        if (m.languageServerConfigured !== undefined) {
                            lsRow.style.display = '';
                            const lsVal = document.getElementById('lang-server-val');
                            if (lsVal) {
                                lsVal.textContent = m.languageServerConfigured ? m.t.configured : m.t.notConfigured;
                                lsVal.className = 'row-value ' + (m.languageServerConfigured ? 'success' : 'error');
                            }
                        } else {
                            lsRow.style.display = 'none';
                        }
                    }

                    // Tunnel alert visibility
                    const tunnelAlert = document.getElementById('tunnel-alert');
                    if (tunnelAlert) {
                        tunnelAlert.style.display = m.remoteProxyReachable ? 'none' : 'flex';
                    }
                }

                // Last updated time
                const lastUpdated = document.getElementById('last-updated');
                if (lastUpdated) {
                    lastUpdated.textContent = m.t.updated + ' ' + m.lastUpdated;
                }

                // Traffic section (innerHTML replace, does not affect form inputs above)
                const trafficContainer = document.getElementById('traffic-container');
                if (trafficContainer && m.trafficHtml !== undefined) {
                    trafficContainer.innerHTML = m.trafficHtml;
                }
            }
        });
    </script>
</body>
</html>`;
    }

    /**
     * Generate diagnostics section HTML
     */
    private generateDiagnosticsHtml(t: typeof i18n.zh, isLocal: boolean): string {
        const checks = this.currentDiagnosticReport?.checks || [
            { id: 'local-proxy', name: 'Local Proxy Service', status: 'pending' as const },
            { id: 'ssh-config', name: 'SSH Configuration', status: 'pending' as const },
            { id: 'remote-forward', name: 'Remote Port Forwarding', status: 'pending' as const },
            { id: 'mgraftcp', name: 'mgraftcp Binary', status: 'pending' as const },
            { id: 'ls-wrapper', name: 'Language Server Wrapper', status: 'pending' as const },
            { id: 'external-connectivity', name: 'External Connectivity', status: 'pending' as const }
        ];

        return checks.map(check => {
            const isLocalCheck = ['local-proxy', 'ssh-config'].includes(check.id);
            const isRemoteCheck = !isLocalCheck;
            const isDisabled = (isLocal && isRemoteCheck) || (!isLocal && isLocalCheck);

            let statusText = '';
            let statusClass = '';

            if (isDisabled) {
                statusText = isLocal ? t.remoteOnly : t.localOnly;
                statusClass = 'muted';
            } else if (check.status === 'pending') {
                statusText = t.pending;
                statusClass = '';
            } else if (check.status === 'running') {
                statusText = '...';
                statusClass = '';
            } else if (check.status === 'success') {
                statusText = '✓';
                statusClass = 'success';
            } else if (check.status === 'warning') {
                statusText = '!';
                statusClass = 'warning';
            } else if (check.status === 'error') {
                statusText = '✗';
                statusClass = 'error';
            }

            // Get message and suggestion from the check
            const message = (check as DiagnosticCheck).message;
            const suggestion = (check as DiagnosticCheck).suggestion;
            const protocolResults = (check as DiagnosticCheck).protocolResults;
            const hasDetails = !isDisabled && (message || suggestion || protocolResults);

            // Generate protocol list HTML for external-connectivity check
            let protocolListHtml = '';
            if (check.id === 'external-connectivity' && protocolResults && protocolResults.length > 0) {
                protocolListHtml = `
                    <div class="protocol-list">
                        ${protocolResults.map((result: ProtocolTestResult, index: number) => {
                    const isLast = index === protocolResults.length - 1;
                    const prefix = isLast ? '└──' : '├──';
                    const statusIcon = result.success ? '✓' : '✗';
                    const statusClass = result.success ? 'success' : 'error';
                    const statusText = result.success ? 'Available' : 'Not working';
                    const currentLabel = result.isCurrent ? ' ← Current' : '';
                    return `
                                <div class="protocol-item">
                                    <span class="protocol-prefix">${prefix}</span>
                                    <span class="protocol-name">${result.protocol.toUpperCase()}:</span>
                                    <span class="protocol-status ${statusClass}">${statusIcon} ${statusText}</span>
                                    ${result.isCurrent ? `<span class="protocol-current">${currentLabel}</span>` : ''}
                                </div>
                            `;
                }).join('')}
                    </div>
                `;
            }

            return `
                <div class="diag-item-wrapper">
                    <div class="diag-item">
                        <div class="diag-dot ${isDisabled ? 'pending' : check.status}"></div>
                        <span class="diag-name ${isDisabled ? 'disabled' : ''}">${this.getDiagnosticCheckName(check.id, t)}</span>
                        <span class="diag-status ${statusClass}">${statusText}</span>
                    </div>
                    ${hasDetails ? `
                    <div class="diag-details">
                        ${protocolListHtml}
                        ${message && !protocolResults ? `<div class="diag-message">${message}</div>` : ''}
                        ${suggestion ? `<div class="diag-suggestion">💡 ${suggestion}</div>` : ''}
                    </div>
                    ` : ''}
                </div>
            `;
        }).join('');
    }

    /**
     * Generate traffic section HTML
     */
    private generateTrafficHtml(t: typeof i18n.zh, stats: TrafficStats, isLocal: boolean): string {
        if (isLocal) {
            return `
                <div class="card">
                    <div class="card-header">
                        <span class="card-title"><span class="card-title-icon">◈</span>${t.traffic}</span>
                    </div>
                    <div class="card-body">
                        <div class="traffic-unavailable">${t.remoteOnly}</div>
                    </div>
                </div>
            `;
        }

        const sessionDuration = this.trafficCollector.getSessionDuration();
        const barWidth = Math.min(stats.activeConnections * 10, 100);

        return `
            <div class="card">
                <div class="card-header">
                    <span class="card-title"><span class="card-title-icon">◈</span>${t.traffic}</span>
                </div>
                <div class="card-body">
                    <div class="traffic-stat">
                        <div class="traffic-label">${t.connections}</div>
                        <div class="traffic-value">${stats.activeConnections}</div>
                        <div class="traffic-bar">
                            <div class="traffic-bar-fill" style="width: ${barWidth}%"></div>
                        </div>
                    </div>
                    <div class="traffic-stat">
                        <div class="traffic-label">${t.session}</div>
                        <div class="traffic-value small">${sessionDuration}</div>
                    </div>
                    <div class="traffic-stat">
                        <div class="traffic-label">${t.totalRequests}</div>
                        <div class="traffic-value small">${stats.totalConnectionsSeen}</div>
                    </div>
                </div>
            </div>
        `;
    }

    dispose(): void {
        this.stopAutoRefresh();
        this.statusBarItem.dispose();
        this.statusPanel?.dispose();
        this.trafficCollector.dispose();
        this.updateCallbacks = [];
    }
}
