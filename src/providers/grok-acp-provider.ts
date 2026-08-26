import {
  formatStructuredAsText,
  PEER_FINDINGS_JSON_SCHEMA,
} from "./grok-schema.js";
import { capabilityProfileForMode } from "./grok-profiles.js";
import { lastFindingsObject } from "./grok-review-quality.js";
import { getSharedGrokAcpPool, type GrokAcpPool } from "./grok-acp-pool.js";
import { grokTurnTimeoutMs } from "./grok-timeout.js";
import type { PeerProvider, PeerRunInput, PeerRunResult } from "./types.js";

export type GrokAcpProviderOptions = {
  pool?: GrokAcpPool;
  command?: string;
  timeoutMs?: number;
};

/**
 * Grok provider backed by a warm ACP process pool.
 * Trades some headless-only flags (sandbox/json-schema CLI args) for lower
 * multi-turn latency via process reuse + native ACP sessions.
 */
export class GrokAcpProvider implements PeerProvider {
  readonly name = "grok" as const;
  private readonly pool: GrokAcpPool;
  private readonly timeoutMs: number;

  constructor(options: GrokAcpProviderOptions = {}) {
    this.pool =
      options.pool ??
      getSharedGrokAcpPool({
        command: options.command,
      });
    this.timeoutMs = grokTurnTimeoutMs(options.timeoutMs);
  }

  async healthCheck() {
    const started = Date.now();
    try {
      const client = await this.pool.getClient(process.cwd());
      await client.ensureStarted();
      return {
        ok: true,
        latencyMs: Date.now() - started,
        detail: "acp-pool-ready",
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async runTurn(input: PeerRunInput): Promise<PeerRunResult> {
    const timeoutMs = input.timeoutMs ?? this.timeoutMs;
    const cwd = input.cwd ?? process.cwd();
    const profile = capabilityProfileForMode(input.mode);
    const wantStructured =
      input.structuredOutput ?? profile.preferParsedFindings;

    // Annotate prompt with peer constraints that headless flags used to enforce.
    const prompt = buildAcpPrompt(input.constructedPrompt, {
      mode: input.mode,
      structured: wantStructured,
    });

    try {
      let sessionId = input.nativeSessionId?.trim() || undefined;
      let resumed = false;
      let client = sessionId
        ? this.pool.findClientForSession(sessionId)
        : undefined;

      if (sessionId && client) {
        resumed = true;
      } else if (sessionId) {
        // Session may still exist on disk — load into a cwd-bound process.
        client = await this.pool.getClient(cwd);
        try {
          await client.loadSession(sessionId, cwd);
          resumed = true;
        } catch {
          // Fall back to a fresh ACP session; app may have sent full prompt.
          sessionId = undefined;
          resumed = false;
        }
      }

      if (!client) {
        client = await this.pool.getClient(cwd);
      }
      if (!sessionId) {
        sessionId = await client.createSession(cwd);
        await input.onNativeSessionId?.(sessionId);
      }

      const result = await client.prompt({
        sessionId,
        text: prompt,
        timeoutMs,
        signal: input.signal,
        onProgress: input.onProgress,
      });

      if (result.cancelled) {
        return {
          isError: true,
          text: result.text,
          stdout: result.text,
          stderr: result.error ?? "Grok ACP cancelled",
          cancelled: true,
          nativeSessionId: sessionId,
          resumed,
          metrics: result.metrics,
          progress: result.progress,
        };
      }
      if (result.timedOut) {
        return {
          isError: true,
          text: result.text,
          stdout: result.text,
          stderr: result.error ?? `Grok ACP timed out after ${timeoutMs}ms`,
          timedOut: true,
          nativeSessionId: sessionId,
          resumed,
          metrics: result.metrics,
          progress: result.progress,
        };
      }
      if (result.isError) {
        return {
          isError: true,
          text: result.text || result.error || "",
          stdout: result.text,
          stderr: result.error ?? "Grok ACP error",
          nativeSessionId: sessionId,
          resumed,
          metrics: result.metrics,
          progress: result.progress,
        };
      }

      let text = result.text;
      let structured: unknown;
      if (wantStructured) {
        structured = lastFindingsObject(text);
        if (structured) {
          const pretty = formatStructuredAsText(structured);
          if (pretty) text = pretty;
        }
      }

      return {
        isError: false,
        text,
        stdout: result.text,
        stderr: "",
        nativeSessionId: sessionId,
        resumed,
        metrics: result.metrics,
        structured,
        progress: result.progress,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        text: "",
        stdout: "",
        stderr: message,
      };
    }
  }
}

function buildAcpPrompt(
  body: string,
  options: { mode: PeerRunInput["mode"]; structured: boolean },
): string {
  const lines = [
    "You are a peer agent consulted by another coding agent via peer-agents-mcp.",
    "Be direct and actionable. Do not assume you have seen another model's answer.",
  ];
  if (options.mode !== "implementer") {
    lines.push(
      "Prefer analysis over edits. Avoid modifying project files unless the task explicitly requires it.",
    );
  } else {
    lines.push(
      "You may edit files and run commands when that helps complete the implementation task.",
    );
  }
  if (options.structured) {
    lines.push(
      "When reporting findings, respond with a single JSON object matching this schema (no markdown fences):",
      JSON.stringify(PEER_FINDINGS_JSON_SCHEMA),
    );
  }
  lines.push("", body);
  return lines.join("\n");
}

