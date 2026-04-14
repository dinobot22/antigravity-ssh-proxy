import * as http from 'http';
import { captureLocalCodexProfile, CodexProfileSnapshot } from './codexProfile';

export const LOCAL_CODEX_PROFILE_BRIDGE_PORT = 50419;

export function getRemoteCodexProfileBridgePort(remoteProxyPort: number): number {
	return remoteProxyPort + 1;
}

async function readJsonFromBridge(url: string): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const req = http.get(url, (res) => {
			const chunks: Buffer[] = [];

			res.on('data', (chunk) => {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			});

			res.on('end', () => {
				const body = Buffer.concat(chunks).toString('utf-8');
				if ((res.statusCode ?? 500) >= 400) {
					reject(new Error(body || `Bridge request failed with status ${res.statusCode}`));
					return;
				}

				try {
					resolve(body ? JSON.parse(body) : {});
				} catch (error) {
					reject(new Error(`Bridge returned invalid JSON: ${error}`));
				}
			});
		});

		req.on('error', reject);
		req.setTimeout(4000, () => {
			req.destroy(new Error('Bridge request timed out'));
		});
	});
}

export class CodexProfileBridgeServer {
	private server: http.Server | undefined;
	private ownedServer = false;

	constructor(private readonly port: number = LOCAL_CODEX_PROFILE_BRIDGE_PORT) {}

	async start(): Promise<{ started: boolean; reusedExisting: boolean }> {
		if (this.server) {
			return { started: true, reusedExisting: false };
		}

		try {
			const result = await this.listen();
			this.server = result.server;
			this.ownedServer = true;
			return { started: true, reusedExisting: false };
		} catch (error: unknown) {
			const err = error as NodeJS.ErrnoException;
			if (err.code === 'EADDRINUSE') {
				const healthy = await this.isHealthy();
				if (healthy) {
					return { started: true, reusedExisting: true };
				}
				throw new Error(`Codex profile bridge port ${this.port} is already in use by another process`);
			}
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (!this.server || !this.ownedServer) {
			return;
		}

		const server = this.server;
		this.server = undefined;
		this.ownedServer = false;

		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});
	}

	async isHealthy(): Promise<boolean> {
		try {
			const response = await readJsonFromBridge(`http://127.0.0.1:${this.port}/healthz`) as { ok?: boolean };
			return response.ok === true;
		} catch {
			return false;
		}
	}

	private async listen(): Promise<{ server: http.Server }> {
		const server = http.createServer(async (req, res) => {
			try {
				if (req.method === 'GET' && req.url === '/healthz') {
					this.writeJson(res, 200, { ok: true });
					return;
				}

				if (req.method === 'GET' && req.url === '/codex-profile') {
					const snapshot = await captureLocalCodexProfile();
					this.writeJson(res, 200, snapshot);
					return;
				}

				this.writeJson(res, 404, { error: 'Not found' });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.writeJson(res, 500, { error: message });
			}
		});

		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(this.port, '127.0.0.1', () => {
				server.removeListener('error', reject);
				resolve();
			});
		});

		return { server };
	}

	private writeJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
		res.writeHead(statusCode, {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store'
		});
		res.end(JSON.stringify(payload));
	}
}

export async function fetchCodexProfileSnapshotFromBridge(
	host: string,
	remoteProxyPort: number
): Promise<CodexProfileSnapshot> {
	const bridgePort = getRemoteCodexProfileBridgePort(remoteProxyPort);
	const response = await readJsonFromBridge(`http://${host}:${bridgePort}/codex-profile`);
	return response as CodexProfileSnapshot;
}
