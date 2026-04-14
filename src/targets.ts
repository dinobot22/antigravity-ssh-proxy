import * as vscode from 'vscode';

export type ManagedTargetId = 'antigravity' | 'codex';

export const DEFAULT_TARGET_APPS: ManagedTargetId[] = ['antigravity', 'codex'];

const VALID_TARGET_APPS = new Set<ManagedTargetId>(DEFAULT_TARGET_APPS);

export function normalizeTargetApps(value: unknown): ManagedTargetId[] {
	if (!Array.isArray(value)) {
		return [...DEFAULT_TARGET_APPS];
	}

	const apps = value
		.filter((item): item is string => typeof item === 'string')
		.map((item) => item.trim().toLowerCase())
		.filter((item): item is ManagedTargetId => VALID_TARGET_APPS.has(item as ManagedTargetId));

	return apps.length > 0 ? Array.from(new Set(apps)) : [...DEFAULT_TARGET_APPS];
}

export function getConfiguredTargetApps(
	config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('antigravity-ssh-proxy')
): ManagedTargetId[] {
	return normalizeTargetApps(config.get<string[]>('targetApps', DEFAULT_TARGET_APPS));
}

export function formatTargetAppsEnv(targetApps: readonly ManagedTargetId[]): string {
	return targetApps.join(',');
}
