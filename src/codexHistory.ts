import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getConfiguredCodexModelProvider } from './codexProfile';

const execFileAsync = promisify(execFile);

const CODEX_DIRNAME = '.codex';
const HISTORY_BACKUP_ROOT = 'atp-codex-history-backups';
const HISTORY_BACKUP_MANIFEST = 'latest-history-backup.json';
const SESSION_DIR_CANDIDATES = ['sessions', 'archived_sessions'] as const;

export interface CodexHistoryBucket {
	provider: string;
	rolloutCount: number;
	threadCount: number;
}

export interface CodexHistoryRebucketPreview {
	sourceProvider: string;
	targetProvider: string;
	currentProvider?: string;
	rolloutCount: number;
	threadCount: number;
}

export interface CodexHistoryRebucketResult extends CodexHistoryRebucketPreview {
	backupDir: string;
}

export interface CodexHistoryRestoreResult {
	backupDir: string;
	sourceProvider?: string;
	targetProvider?: string;
	restoredRollouts: number;
	restoredStateFiles: string[];
	removedStateFiles: string[];
}

interface HistoryBackupMetadata {
	createdAt: string;
	reason: string;
	sourceProvider?: string;
	targetProvider?: string;
	changedRollouts: string[];
	stateDbBaseName?: string;
	backedUpStateFiles: string[];
	missingStateFiles: string[];
}

interface StateDbSelection {
	baseName?: string;
	fileNames: string[];
}

function getCodexDir(): string {
	return path.join(os.homedir(), CODEX_DIRNAME);
}

function getHistoryBackupRoot(): string {
	return path.join(getCodexDir(), HISTORY_BACKUP_ROOT);
}

function getHistoryBackupManifestPath(): string {
	return path.join(getHistoryBackupRoot(), HISTORY_BACKUP_MANIFEST);
}

function getTimestampLabel(date = new Date()): string {
	return date.toISOString().replace(/[:.]/g, '-');
}

async function readTextFileIfExists(filePath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(filePath, 'utf-8');
	} catch (error: unknown) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function listRolloutFilesRecursive(dirPath: string): Promise<string[]> {
	const entries = await fs.readdir(dirPath, { withFileTypes: true });
	const files: string[] = [];

	for (const entry of entries) {
		const fullPath = path.join(dirPath, entry.name);
		if (entry.isDirectory()) {
			files.push(...await listRolloutFilesRecursive(fullPath));
		} else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
			files.push(fullPath);
		}
	}

	return files;
}

async function getRolloutDirectories(): Promise<string[]> {
	const codexDir = getCodexDir();
	const dirs: string[] = [];

	for (const candidate of SESSION_DIR_CANDIDATES) {
		const fullPath = path.join(codexDir, candidate);
		if (await pathExists(fullPath)) {
			dirs.push(fullPath);
		}
	}

	return dirs;
}

function parseSessionMetaProvider(fileContent: string): string | undefined {
	for (const line of fileContent.split('\n')) {
		if (!line.includes('"type":"session_meta"')) {
			continue;
		}

		try {
			const parsed = JSON.parse(line) as {
				type?: string;
				payload?: { model_provider?: string };
			};
			if (parsed.type === 'session_meta') {
				return parsed.payload?.model_provider;
			}
		} catch {
			continue;
		}
	}

	return undefined;
}

async function getRolloutProvider(filePath: string): Promise<string | undefined> {
	const content = await readTextFileIfExists(filePath);
	if (!content) {
		return undefined;
	}
	return parseSessionMetaProvider(content);
}

async function collectRolloutProviderMap(): Promise<Map<string, string[]>> {
	const providerMap = new Map<string, string[]>();
	const directories = await getRolloutDirectories();

	for (const directory of directories) {
		for (const filePath of await listRolloutFilesRecursive(directory)) {
			const provider = await getRolloutProvider(filePath);
			if (!provider) {
				continue;
			}
			const files = providerMap.get(provider) ?? [];
			files.push(filePath);
			providerMap.set(provider, files);
		}
	}

	return providerMap;
}

function parseProviderCountRows(stdout: string): Map<string, number> {
	const result = new Map<string, number>();
	for (const line of stdout.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		const [provider, countRaw] = line.split('|');
		if (!provider || !countRaw) {
			continue;
		}
		const count = Number.parseInt(countRaw, 10);
		if (!Number.isNaN(count)) {
			result.set(provider, count);
		}
	}
	return result;
}

async function getStateDbSelection(): Promise<StateDbSelection> {
	const codexDir = getCodexDir();
	let entries;
	try {
		entries = await fs.readdir(codexDir, { withFileTypes: true });
	} catch (error: unknown) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === 'ENOENT') {
			return { fileNames: [] };
		}
		throw error;
	}
	const bases = entries
		.filter(entry => entry.isFile() && /^state_\d+\.sqlite$/.test(entry.name))
		.map(entry => entry.name)
		.sort((left, right) => {
			const leftNum = Number.parseInt(left.match(/^state_(\d+)\.sqlite$/)?.[1] ?? '0', 10);
			const rightNum = Number.parseInt(right.match(/^state_(\d+)\.sqlite$/)?.[1] ?? '0', 10);
			return rightNum - leftNum;
		});

	if (bases.length === 0) {
		return { fileNames: [] };
	}

	const baseName = bases[0];
	const fileNames = [baseName, `${baseName}-wal`, `${baseName}-shm`];
	return { baseName, fileNames };
}

function escapeSqlLiteral(value: string): string {
	return value.replace(/'/g, "''");
}

async function execSqlite(dbPath: string, sql: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync('sqlite3', [dbPath, sql]);
		return stdout;
	} catch (error: unknown) {
		const err = error as NodeJS.ErrnoException & { stderr?: string };
		if (err.code === 'ENOENT') {
			throw new Error('sqlite3 command is required for Codex history rebucketing but was not found on this machine');
		}
		throw new Error(err.stderr?.trim() || err.message || 'sqlite3 command failed');
	}
}

async function getThreadProviderCounts(): Promise<Map<string, number>> {
	const selection = await getStateDbSelection();
	if (!selection.baseName) {
		return new Map();
	}

	const dbPath = path.join(getCodexDir(), selection.baseName);
	const stdout = await execSqlite(
		dbPath,
		'SELECT model_provider, COUNT(*) FROM threads GROUP BY model_provider ORDER BY COUNT(*) DESC, model_provider ASC;'
	);
	return parseProviderCountRows(stdout);
}

async function getThreadCountForProvider(provider: string): Promise<number> {
	const selection = await getStateDbSelection();
	if (!selection.baseName) {
		return 0;
	}

	const dbPath = path.join(getCodexDir(), selection.baseName);
	const stdout = await execSqlite(
		dbPath,
		`SELECT COUNT(*) FROM threads WHERE model_provider='${escapeSqlLiteral(provider)}';`
	);
	return Number.parseInt(stdout.trim() || '0', 10) || 0;
}

async function updateThreadProviderBucket(sourceProvider: string, targetProvider: string): Promise<void> {
	const selection = await getStateDbSelection();
	if (!selection.baseName) {
		return;
	}

	const dbPath = path.join(getCodexDir(), selection.baseName);
	await execSqlite(
		dbPath,
		[
			'BEGIN IMMEDIATE;',
			`UPDATE threads SET model_provider='${escapeSqlLiteral(targetProvider)}' WHERE model_provider='${escapeSqlLiteral(sourceProvider)}';`,
			'COMMIT;',
			'PRAGMA wal_checkpoint(FULL);'
		].join(' ')
	);
}

async function rewriteRolloutProviderBucket(filePath: string, sourceProvider: string, targetProvider: string): Promise<boolean> {
	const original = await fs.readFile(filePath, 'utf-8');
	const hadTrailingNewline = original.endsWith('\n');
	let changed = false;

	const rewrittenLines = original.split('\n').map(line => {
		if (!line.includes('"type":"session_meta"')) {
			return line;
		}

		try {
			const parsed = JSON.parse(line) as {
				type?: string;
				payload?: { model_provider?: string };
			};
			if (parsed.type === 'session_meta' && parsed.payload?.model_provider === sourceProvider) {
				parsed.payload.model_provider = targetProvider;
				changed = true;
				return JSON.stringify(parsed);
			}
		} catch {
			return line;
		}

		return line;
	});

	if (!changed) {
		return false;
	}

	const rewritten = rewrittenLines.join('\n');
	await fs.writeFile(filePath, hadTrailingNewline ? `${rewritten}\n` : rewritten, 'utf-8');
	return true;
}

async function readHistoryBackupMetadata(backupDir: string): Promise<HistoryBackupMetadata> {
	const raw = await fs.readFile(path.join(backupDir, 'metadata.json'), 'utf-8');
	return JSON.parse(raw) as HistoryBackupMetadata;
}

async function createHistoryBackup(
	reason: string,
	changedRollouts: string[],
	sourceProvider?: string,
	targetProvider?: string,
	options?: { updateLatestManifest?: boolean }
): Promise<{ backupDir: string; metadata: HistoryBackupMetadata }> {
	const codexDir = getCodexDir();
	const backupRoot = getHistoryBackupRoot();
	const backupDir = path.join(backupRoot, `${getTimestampLabel()}-${reason}`);
	await fs.mkdir(backupDir, { recursive: true });

	const backedUpStateFiles: string[] = [];
	const missingStateFiles: string[] = [];
	const stateSelection = await getStateDbSelection();

	for (const relativePath of changedRollouts) {
		const sourcePath = path.join(codexDir, relativePath);
		const backupPath = path.join(backupDir, 'rollouts', relativePath);
		await fs.mkdir(path.dirname(backupPath), { recursive: true });
		await fs.copyFile(sourcePath, backupPath);
	}

	for (const stateFile of stateSelection.fileNames) {
		const sourcePath = path.join(codexDir, stateFile);
		const backupPath = path.join(backupDir, 'state', stateFile);
		if (await pathExists(sourcePath)) {
			await fs.mkdir(path.dirname(backupPath), { recursive: true });
			await fs.copyFile(sourcePath, backupPath);
			backedUpStateFiles.push(stateFile);
		} else {
			missingStateFiles.push(stateFile);
		}
	}

	const metadata: HistoryBackupMetadata = {
		createdAt: new Date().toISOString(),
		reason,
		sourceProvider,
		targetProvider,
		changedRollouts,
		stateDbBaseName: stateSelection.baseName,
		backedUpStateFiles,
		missingStateFiles
	};

	await fs.writeFile(
		path.join(backupDir, 'metadata.json'),
		JSON.stringify(metadata, null, 2),
		'utf-8'
	);

	if (options?.updateLatestManifest !== false) {
		await fs.mkdir(backupRoot, { recursive: true });
		await fs.writeFile(
			getHistoryBackupManifestPath(),
			JSON.stringify({ backupDir }, null, 2),
			'utf-8'
		);
	}

	return { backupDir, metadata };
}

export async function getCodexHistoryBuckets(): Promise<CodexHistoryBucket[]> {
	const rolloutProviders = await collectRolloutProviderMap();
	const threadProviders = await getThreadProviderCounts();
	const bucketNames = new Set<string>([
		...rolloutProviders.keys(),
		...threadProviders.keys()
	]);

	return [...bucketNames]
		.map(provider => ({
			provider,
			rolloutCount: rolloutProviders.get(provider)?.length ?? 0,
			threadCount: threadProviders.get(provider) ?? 0
		}))
		.sort((left, right) => {
			const leftTotal = left.rolloutCount + left.threadCount;
			const rightTotal = right.rolloutCount + right.threadCount;
			if (rightTotal !== leftTotal) {
				return rightTotal - leftTotal;
			}
			return left.provider.localeCompare(right.provider);
		});
}

export async function previewCodexHistoryRebucket(
	sourceProvider: string,
	targetProvider: string
): Promise<CodexHistoryRebucketPreview> {
	const rolloutProviders = await collectRolloutProviderMap();
	return {
		sourceProvider,
		targetProvider,
		currentProvider: await getConfiguredCodexModelProvider(),
		rolloutCount: rolloutProviders.get(sourceProvider)?.length ?? 0,
		threadCount: await getThreadCountForProvider(sourceProvider)
	};
}

export async function rebucketCodexHistory(
	sourceProvider: string,
	targetProvider: string
): Promise<CodexHistoryRebucketResult> {
	const preview = await previewCodexHistoryRebucket(sourceProvider, targetProvider);
	const codexDir = getCodexDir();
	const rolloutProviders = await collectRolloutProviderMap();
	const changedRollouts = (rolloutProviders.get(sourceProvider) ?? [])
		.map(filePath => path.relative(codexDir, filePath));

	const { backupDir } = await createHistoryBackup(
		'before-history-rebucket',
		changedRollouts,
		sourceProvider,
		targetProvider
	);

	for (const relativePath of changedRollouts) {
		await rewriteRolloutProviderBucket(
			path.join(codexDir, relativePath),
			sourceProvider,
			targetProvider
		);
	}

	if (preview.threadCount > 0) {
		await updateThreadProviderBucket(sourceProvider, targetProvider);
	}

	return {
		...preview,
		backupDir
	};
}

export async function restoreLatestCodexHistoryBackup(): Promise<CodexHistoryRestoreResult> {
	const manifestRaw = await readTextFileIfExists(getHistoryBackupManifestPath());
	if (!manifestRaw) {
		throw new Error('No previous ATP Codex history backup is available');
	}

	const { backupDir } = JSON.parse(manifestRaw) as { backupDir?: string };
	if (!backupDir) {
		throw new Error('Latest history backup manifest is invalid');
	}

	const metadata = await readHistoryBackupMetadata(backupDir);
	const codexDir = getCodexDir();

	await createHistoryBackup(
		'before-history-restore',
		metadata.changedRollouts,
		metadata.targetProvider,
		metadata.sourceProvider,
		{ updateLatestManifest: false }
	);

	for (const relativePath of metadata.changedRollouts) {
		const backupPath = path.join(backupDir, 'rollouts', relativePath);
		const targetPath = path.join(codexDir, relativePath);
		await fs.mkdir(path.dirname(targetPath), { recursive: true });
		await fs.copyFile(backupPath, targetPath);
	}

	const restoredStateFiles: string[] = [];
	const removedStateFiles: string[] = [];

	for (const stateFile of metadata.backedUpStateFiles) {
		const backupPath = path.join(backupDir, 'state', stateFile);
		const targetPath = path.join(codexDir, stateFile);
		if (await pathExists(backupPath)) {
			await fs.copyFile(backupPath, targetPath);
			restoredStateFiles.push(stateFile);
		}
	}

	for (const stateFile of metadata.missingStateFiles) {
		const targetPath = path.join(codexDir, stateFile);
		if (await pathExists(targetPath)) {
			await fs.unlink(targetPath);
			removedStateFiles.push(stateFile);
		}
	}

	return {
		backupDir,
		sourceProvider: metadata.sourceProvider,
		targetProvider: metadata.targetProvider,
		restoredRollouts: metadata.changedRollouts.length,
		restoredStateFiles,
		removedStateFiles
	};
}
