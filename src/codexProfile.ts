import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const CODEX_DIRNAME = '.codex';
const PROFILE_BACKUP_ROOT = 'atp-codex-profile-backups';
const PROFILE_BACKUP_MANIFEST = 'latest-profile-backup.json';

const MANAGED_CODEX_FILES = [
	{ name: 'auth.json', mode: 0o600, requiredForCapture: true },
	{ name: 'config.toml', mode: 0o600, requiredForCapture: true },
	{ name: 'installation_id', mode: 0o644, requiredForCapture: false }
] as const;

type ManagedCodexFile = typeof MANAGED_CODEX_FILES[number];
type ManagedCodexFilename = ManagedCodexFile['name'];

export interface CodexProfileSnapshot {
	createdAt: string;
	modelProvider?: string;
	files: Array<{
		name: ManagedCodexFilename;
		content: string;
	}>;
}

interface CodexProfileBackupMetadata {
	createdAt: string;
	reason: string;
	modelProvider?: string;
	backedUpFiles: ManagedCodexFilename[];
	missingFiles: ManagedCodexFilename[];
}

export interface CodexProfileApplyResult {
	backupDir: string;
	modelProvider?: string;
	writtenFiles: ManagedCodexFilename[];
}

export interface CodexProfileRestoreResult {
	backupDir: string;
	modelProvider?: string;
	restoredFiles: ManagedCodexFilename[];
	removedFiles: ManagedCodexFilename[];
}

function getCodexDir(): string {
	return path.join(os.homedir(), CODEX_DIRNAME);
}

function getProfileBackupRoot(): string {
	return path.join(getCodexDir(), PROFILE_BACKUP_ROOT);
}

function getProfileBackupManifestPath(): string {
	return path.join(getProfileBackupRoot(), PROFILE_BACKUP_MANIFEST);
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

function parseModelProvider(configToml: string | undefined): string | undefined {
	if (!configToml) {
		return undefined;
	}
	const match = configToml.match(/^\s*model_provider\s*=\s*"([^"]+)"/m);
	return match?.[1];
}

async function writeManagedCodexFile(targetPath: string, content: string, mode: number): Promise<void> {
	await fs.writeFile(targetPath, content, { encoding: 'utf-8', mode });
	try {
		await fs.chmod(targetPath, mode);
	} catch {
		// chmod may not be supported on every platform; best effort is enough here.
	}
}

async function readBackupMetadata(backupDir: string): Promise<CodexProfileBackupMetadata> {
	const metadataPath = path.join(backupDir, 'metadata.json');
	const raw = await fs.readFile(metadataPath, 'utf-8');
	return JSON.parse(raw) as CodexProfileBackupMetadata;
}

export async function captureLocalCodexProfile(): Promise<CodexProfileSnapshot> {
	const codexDir = getCodexDir();
	const files: CodexProfileSnapshot['files'] = [];

	for (const entry of MANAGED_CODEX_FILES) {
		const filePath = path.join(codexDir, entry.name);
		const content = await readTextFileIfExists(filePath);
		if (content === undefined) {
			if (entry.requiredForCapture) {
				throw new Error(`Local Codex profile is missing ${entry.name}`);
			}
			continue;
		}
		files.push({ name: entry.name, content });
	}

	const configToml = files.find(file => file.name === 'config.toml')?.content;
	return {
		createdAt: new Date().toISOString(),
		modelProvider: parseModelProvider(configToml),
		files
	};
}

async function createCodexProfileBackup(
	reason: string,
	options?: { updateLatestManifest?: boolean }
): Promise<{ backupDir: string; metadata: CodexProfileBackupMetadata }> {
	const codexDir = getCodexDir();
	const backupRoot = getProfileBackupRoot();
	const backupDir = path.join(backupRoot, `${getTimestampLabel()}-${reason}`);
	await fs.mkdir(backupDir, { recursive: true });

	const backedUpFiles: ManagedCodexFilename[] = [];
	const missingFiles: ManagedCodexFilename[] = [];
	let modelProvider: string | undefined;

	for (const entry of MANAGED_CODEX_FILES) {
		const sourcePath = path.join(codexDir, entry.name);
		if (await pathExists(sourcePath)) {
			await fs.copyFile(sourcePath, path.join(backupDir, entry.name));
			backedUpFiles.push(entry.name);
			if (entry.name === 'config.toml') {
				modelProvider = parseModelProvider(await readTextFileIfExists(sourcePath));
			}
		} else {
			missingFiles.push(entry.name);
		}
	}

	const metadata: CodexProfileBackupMetadata = {
		createdAt: new Date().toISOString(),
		reason,
		modelProvider,
		backedUpFiles,
		missingFiles
	};

	await fs.writeFile(
		path.join(backupDir, 'metadata.json'),
		JSON.stringify(metadata, null, 2),
		'utf-8'
	);

	if (options?.updateLatestManifest !== false) {
		await fs.mkdir(backupRoot, { recursive: true });
		await fs.writeFile(
			getProfileBackupManifestPath(),
			JSON.stringify({ backupDir }, null, 2),
			'utf-8'
		);
	}

	return { backupDir, metadata };
}

export async function applyCodexProfileSnapshot(snapshot: CodexProfileSnapshot): Promise<CodexProfileApplyResult> {
	const codexDir = getCodexDir();
	await fs.mkdir(codexDir, { recursive: true });

	const { backupDir } = await createCodexProfileBackup('before-sync');
	const writtenFiles: ManagedCodexFilename[] = [];

	for (const entry of MANAGED_CODEX_FILES) {
		const snapshotFile = snapshot.files.find(file => file.name === entry.name);
		if (!snapshotFile) {
			continue;
		}
		await writeManagedCodexFile(
			path.join(codexDir, entry.name),
			snapshotFile.content,
			entry.mode
		);
		writtenFiles.push(entry.name);
	}

	return {
		backupDir,
		modelProvider: snapshot.modelProvider,
		writtenFiles
	};
}

export async function restoreLatestCodexProfileBackup(): Promise<CodexProfileRestoreResult> {
	const manifestPath = getProfileBackupManifestPath();
	const manifestRaw = await readTextFileIfExists(manifestPath);
	if (!manifestRaw) {
		throw new Error('No previous ATP Codex profile backup is available');
	}

	const { backupDir } = JSON.parse(manifestRaw) as { backupDir?: string };
	if (!backupDir) {
		throw new Error('Latest backup manifest is invalid');
	}

	const metadata = await readBackupMetadata(backupDir);
	const codexDir = getCodexDir();
	await fs.mkdir(codexDir, { recursive: true });

	// Preserve the current remote state before restoring, but keep the manifest
	// pointing at the original "before-sync" backup so repeated restore is stable.
	await createCodexProfileBackup('before-restore', { updateLatestManifest: false });

	const restoredFiles: ManagedCodexFilename[] = [];
	const removedFiles: ManagedCodexFilename[] = [];

	for (const entry of MANAGED_CODEX_FILES) {
		const targetPath = path.join(codexDir, entry.name);
		const backupPath = path.join(backupDir, entry.name);
		if (metadata.backedUpFiles.includes(entry.name) && await pathExists(backupPath)) {
			await fs.copyFile(backupPath, targetPath);
			try {
				await fs.chmod(targetPath, entry.mode);
			} catch {
				// best effort
			}
			restoredFiles.push(entry.name);
			continue;
		}

		if (metadata.missingFiles.includes(entry.name) && await pathExists(targetPath)) {
			await fs.unlink(targetPath);
			removedFiles.push(entry.name);
		}
	}

	return {
		backupDir,
		modelProvider: metadata.modelProvider,
		restoredFiles,
		removedFiles
	};
}

export async function getConfiguredCodexModelProvider(): Promise<string | undefined> {
	return parseModelProvider(await readTextFileIfExists(path.join(getCodexDir(), 'config.toml')));
}
