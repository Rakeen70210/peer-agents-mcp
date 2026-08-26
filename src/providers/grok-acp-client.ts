import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { readFile } from "node:fs/promises";

import type { PeerRunMetrics, PeerRunProgress } from "./types.js";

type JsonRpcId = number | string;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type AcpPromptResult = {
  text: string;
  sessionId: string;
  stopReason?: string;
  metrics?: PeerRunMetrics;
  progress?: PeerRunProgress;
  cancelled?: boolean;
  timedOut?: boolean;
  isError?: boolean;
  error?: string;
};

export type GrokAcpClientOptions = {
  command?: string;
  /** Extra args before `stdio` (e.g. agent profile). */
  agentArgs?: string[];
  idleTimeoutMs?: number;
  /** Called when the process exits unexpectedly. */
  onExit?: (code: number | null) => void;
};

/**
 * Long-lived JSON-RPC client for `grok agent --always-approve stdio`.
 * One client owns one agent process and can host multiple sessions.
 */
export class GrokAcpClient {
  private readonly command: string;
  private readonly agentArgs: string[];
  private readonly idleTimeoutMs: number;
  private readonly onExit?: (code: number | null) => void;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private readline: Interface | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, Pending>();
  private initialized = false;
  private starting: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private promptDepth = 0;

  /** ACP session ids known to be live on this process. */
  readonly liveSessions = new Set<string>();

  constructor(options: GrokAcpClientOptions = {}) {
    this.command = options.command ?? process.env.GROK_COMMAND ?? "grok";
    this.agentArgs = options.agentArgs ?? [];
    this.idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000;
    this.onExit = options.onExit;
  }

  get isAlive(): boolean {
    return Boolean(this.proc && !this.proc.killed && this.initialized);
  }

  touch(): void {
    if (this.promptDepth > 0) {
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
      return;
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.idleTimeoutMs <= 0 || this.closed) return;
    this.idleTimer = setTimeout(() => {
      void this.dispose();
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  async ensureStarted(): Promise<void> {
    if (this.closed) throw new Error("ACP client is closed");
    if (this.initialized && this.proc && !this.proc.killed) {
      this.touch();
      return;
    }
    if (this.starting) {
      await this.starting;
      return;
    }
    this.starting = this.startProcess();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startProcess(): Promise<void> {
    this.cleanupProcessHandles();

    const args = ["agent", "--always-approve", ...this.agentArgs, "stdio"];
    const proc = spawn(this.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    this.proc = proc;

    const rl = createInterface({ input: proc.stdout });
    this.readline = rl;
    rl.on("line", (line) => this.onLine(line));

    proc.on("exit", (code) => {
      this.initialized = false;
      this.rejectAllPending(new Error(`ACP process exited (${code ?? "null"})`));
      this.liveSessions.clear();
      this.onExit?.(code);
    });

    proc.stderr.on("data", () => {
      // stderr noise ignored; available if we later capture diagnostics
    });

    await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        // Prefer agent-side tools; avoid client fs round-trips for peers.
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: {
        name: "peer-agents-mcp",
        version: "0.5.0",
      },
    });
    this.initialized = true;
    this.touch();
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: {
      jsonrpc?: string;
      id?: JsonRpcId;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string; code?: number; data?: unknown };
    };
    try {
      msg = JSON.parse(trimmed) as typeof msg;
    } catch {
      return;
    }

    // Server requests / notifications
    if (msg.method && msg.id !== undefined && !("result" in msg) && !("error" in msg)) {
      void this.handleServerRequest(msg.method, msg.id, msg.params);
      return;
    }
    if (msg.method && msg.id === undefined) {
      // notifications ignored (session/update handled in prompt collector)
      return;
    }

    if (msg.id === undefined) return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      const message =
        msg.error.message ||
        (msg.error.code !== undefined
          ? `ACP error ${msg.error.code}`
          : "ACP error");
      pending.reject(new Error(message));
      return;
    }
    pending.resolve(msg.result);
  }

  private async handleServerRequest(
    method: string,
    id: JsonRpcId,
    params: unknown,
  ): Promise<void> {
    try {
      if (method === "session/request_permission") {
        // Always allow in peer automation mode.
        this.respond(id, {
          outcome: {
            outcome: "selected",
            optionId: "allow-always",
          },
        });
        return;
      }
      if (method === "fs/read_text_file" || method === "fs/readTextFile") {
        const path =
          (params as { path?: string })?.path ??
          (params as { uri?: string })?.uri?.replace(/^file:\/\//, "");
        if (!path) {
          this.respondError(id, "Missing path");
          return;
        }
        const text = await readFile(path, "utf8");
        this.respond(id, { content: text });
        return;
      }
      // Unknown server request — cancel/deny safely.
      this.respond(id, { outcome: { outcome: "cancelled" } });
    } catch (error) {
      this.respondError(
        id,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private respond(id: JsonRpcId, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private respondError(id: JsonRpcId, message: string): void {
    this.write({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message },
    });
  }

  private write(payload: unknown): void {
    if (!this.proc?.stdin.writable) {
      throw new Error("ACP process stdin is not writable");
    }
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private sendSessionCancel(sessionId: string): void {
    try {
      this.write({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId },
      });
    } catch {
      // ignore
    }
    this.liveSessions.delete(sessionId);
  }

  private request(method: string, params?: unknown, timeoutMs = 60_000): Promise<unknown> {
    this.promptDepth += 1;
    this.touch();
    const id = this.nextId++;
    const settle = () => {
      this.promptDepth = Math.max(0, this.promptDepth - 1);
      this.touch();
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (method === "session/prompt") {
          const sid = (params as { sessionId?: string } | undefined)?.sessionId;
          if (sid) this.sendSessionCancel(sid);
        }
        settle();
        reject(new Error(`ACP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          settle();
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          settle();
          reject(error);
        },
      });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        settle();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  async createSession(cwd: string): Promise<string> {
    await this.ensureStarted();
    const result = (await this.request("session/new", {
      cwd,
      mcpServers: [],
    })) as { sessionId?: string };
    if (!result?.sessionId) {
      throw new Error("ACP session/new did not return sessionId");
    }
    this.liveSessions.add(result.sessionId);
    this.touch();
    return result.sessionId;
  }

  /**
   * Load an existing Grok session into this process (replays history to us).
   */
  async loadSession(sessionId: string, cwd: string): Promise<void> {
    await this.ensureStarted();
    await this.request(
      "session/load",
      {
        sessionId,
        cwd,
        mcpServers: [],
      },
      120_000,
    );
    this.liveSessions.add(sessionId);
    this.touch();
  }

  async prompt(input: {
    sessionId: string;
    text: string;
    timeoutMs: number;
    signal?: AbortSignal;
    onProgress?: (progress: PeerRunProgress) => void;
  }): Promise<AcpPromptResult> {
    this.promptDepth += 1;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    let text = "";
    let lastThought = "";
    let lastTool = "";
    let toolCallCount = 0;
    let eventCount = 0;
    let stopReason: string | undefined;
    let metrics: PeerRunMetrics | undefined;

    const progressSnapshot = (): PeerRunProgress => ({
      updatedAt: new Date().toISOString(),
      eventCount,
      textSnippet: text.slice(-500) || undefined,
      lastThought: lastThought.slice(-400) || undefined,
      lastTool: lastTool || undefined,
      toolCallCount: toolCallCount || undefined,
      stopReason,
    });

    const onLine = (line: string) => {
      let msg: {
        method?: string;
        params?: {
          sessionId?: string;
          update?: {
            sessionUpdate?: string;
            content?: { type?: string; text?: string };
            toolName?: string;
            title?: string;
            status?: string;
            stop_reason?: string;
            usage?: {
              inputTokens?: number;
              outputTokens?: number;
              totalTokens?: number;
            };
          };
        };
      };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        return;
      }
      if (msg.method !== "session/update") return;
      if (msg.params?.sessionId && msg.params.sessionId !== input.sessionId) {
        return;
      }
      const update = msg.params?.update;
      if (!update?.sessionUpdate) return;
      eventCount += 1;
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content?.text
      ) {
        text += update.content.text;
      } else if (
        update.sessionUpdate === "agent_thought_chunk" &&
        update.content?.text
      ) {
        lastThought += update.content.text;
        if (lastThought.length > 800) {
          lastThought = lastThought.slice(-800);
        }
      } else {
        const toolLabel = update.toolName ?? update.title;
        const isTool =
          update.sessionUpdate === "tool_call" ||
          update.sessionUpdate === "tool_call_update" ||
          /tool/i.test(update.sessionUpdate) ||
          Boolean(toolLabel);
        if (isTool) {
          if (update.sessionUpdate !== "tool_call_update") {
            toolCallCount += 1;
          }
          if (toolLabel) lastTool = toolLabel;
          if (!lastThought && lastTool) lastThought = lastTool;
        }
      }
      input.onProgress?.(progressSnapshot());
    };

    const rlHandler = (line: string) => onLine(line);
    const abortHandler = () => {
      this.sendSessionCancel(input.sessionId);
    };

    try {
      await this.ensureStarted();
      if (input.signal?.aborted) {
        return {
          text: "",
          sessionId: input.sessionId,
          cancelled: true,
          isError: true,
          error: "Cancelled before start",
        };
      }

      this.readline?.on("line", rlHandler);
      input.signal?.addEventListener("abort", abortHandler, { once: true });

      const result = (await this.request(
        "session/prompt",
        {
          sessionId: input.sessionId,
          prompt: [{ type: "text", text: input.text }],
        },
        input.timeoutMs,
      )) as {
        stopReason?: string;
        _meta?: {
          inputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
          cachedReadTokens?: number;
          reasoningTokens?: number;
          usage?: {
            inputTokens?: number;
            outputTokens?: number;
            totalTokens?: number;
            cacheReadInputTokens?: number;
            reasoningTokens?: number;
          };
        };
      };

      stopReason = result?.stopReason;
      const meta = result?._meta;
      const usage = meta?.usage;
      if (meta || usage) {
        metrics = {
          stopReason,
          usage: {
            inputTokens: usage?.inputTokens ?? meta?.inputTokens,
            outputTokens: usage?.outputTokens ?? meta?.outputTokens,
            totalTokens: usage?.totalTokens ?? meta?.totalTokens,
            cacheReadInputTokens:
              usage?.cacheReadInputTokens ?? meta?.cachedReadTokens,
            reasoningTokens:
              usage?.reasoningTokens ?? meta?.reasoningTokens,
          },
        };
      }

      if (input.signal?.aborted || stopReason === "cancelled") {
        return {
          text: text.trim(),
          sessionId: input.sessionId,
          stopReason,
          metrics,
          cancelled: true,
          isError: true,
          error: "Cancelled",
          progress: progressSnapshot(),
        };
      }

      return {
        text: text.trim(),
        sessionId: input.sessionId,
        stopReason,
        metrics,
        progress: progressSnapshot(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = /timed out/i.test(message);
      if (timedOut || input.signal?.aborted) {
        this.sendSessionCancel(input.sessionId);
      }
      return {
        text: text.trim(),
        sessionId: input.sessionId,
        stopReason,
        metrics,
        isError: true,
        timedOut,
        cancelled: input.signal?.aborted,
        error: message,
        progress: progressSnapshot(),
      };
    } finally {
      this.readline?.off("line", rlHandler);
      input.signal?.removeEventListener("abort", abortHandler);
      this.promptDepth -= 1;
      this.touch();
    }
  }

  async dispose(): Promise<void> {
    this.closed = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.rejectAllPending(new Error("ACP client disposed"));
    this.cleanupProcessHandles();
  }

  private cleanupProcessHandles(): void {
    try {
      this.readline?.close();
    } catch {
      // ignore
    }
    this.readline = null;
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    this.proc = null;
    this.initialized = false;
    this.liveSessions.clear();
  }
}
