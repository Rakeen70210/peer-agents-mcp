import { resolve } from "node:path";

import { GrokAcpClient } from "./grok-acp-client.js";
import { grokAcpIdleTimeoutMs } from "./grok-timeout.js";
import { parsePositiveInt } from "./runner.js";

export type GrokAcpPoolOptions = {
  command?: string;
  maxClients?: number;
  idleTimeoutMs?: number;
};

/**
 * Process pool for Grok ACP agents, keyed by absolute cwd.
 * Reuses a warm `grok agent stdio` process across peer turns.
 */
export class GrokAcpPool {
  private readonly command: string;
  private readonly maxClients: number;
  private readonly idleTimeoutMs: number;
  private readonly clients = new Map<string, GrokAcpClient>();

  constructor(options: GrokAcpPoolOptions = {}) {
    this.command = options.command ?? process.env.GROK_COMMAND ?? "grok";
    this.maxClients =
      options.maxClients ??
      parsePositiveInt(process.env.PEER_AGENTS_GROK_ACP_MAX_CLIENTS, 4);
    this.idleTimeoutMs = options.idleTimeoutMs ?? grokAcpIdleTimeoutMs();
  }

  private keyFor(cwd: string): string {
    return resolve(cwd || process.cwd());
  }

  async getClient(cwd: string): Promise<GrokAcpClient> {
    const key = this.keyFor(cwd);
    let client = this.clients.get(key);
    if (client?.isAlive) {
      client.touch();
      return client;
    }
    if (client) {
      await client.dispose().catch(() => undefined);
      this.clients.delete(key);
    }

    // Evict oldest if at capacity.
    while (this.clients.size >= this.maxClients) {
      const firstKey = this.clients.keys().next().value as string | undefined;
      if (!firstKey) break;
      const old = this.clients.get(firstKey);
      this.clients.delete(firstKey);
      await old?.dispose().catch(() => undefined);
    }

    client = new GrokAcpClient({
      command: this.command,
      idleTimeoutMs: this.idleTimeoutMs,
      onExit: () => {
        // Drop dead client from pool.
        if (this.clients.get(key) === client) {
          this.clients.delete(key);
        }
      },
    });
    await client.ensureStarted();
    this.clients.set(key, client);
    return client;
  }

  /** Find a live client that already hosts this session id. */
  findClientForSession(sessionId: string): GrokAcpClient | undefined {
    for (const client of this.clients.values()) {
      if (client.isAlive && client.liveSessions.has(sessionId)) {
        return client;
      }
    }
    return undefined;
  }

  async disposeAll(): Promise<void> {
    const all = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(all.map((c) => c.dispose().catch(() => undefined)));
  }

  get size(): number {
    return this.clients.size;
  }
}

/** Shared process pool for the MCP server process. */
let sharedPool: GrokAcpPool | undefined;

export function getSharedGrokAcpPool(options?: GrokAcpPoolOptions): GrokAcpPool {
  if (!sharedPool) {
    sharedPool = new GrokAcpPool(options);
  }
  return sharedPool;
}

export async function disposeSharedGrokAcpPool(): Promise<void> {
  if (sharedPool) {
    await sharedPool.disposeAll();
    sharedPool = undefined;
  }
}
