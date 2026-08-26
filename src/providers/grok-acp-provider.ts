import {
  formatStructuredAsText,
  PEER_FINDINGS_JSON_SCHEMA,
} from "./grok-schema.js";
import { capabilityProfileForMode } from "./grok-profiles.js";
import {
  CONTINUATION_PROMPT,
  isIncompletePeerReview,
  lastFindingsObject,
} from "./grok-review-quality.js";
import { getSharedGrokAcpPool, type GrokAcpPool } from "./grok-acp-pool.js";
import type { AcpPromptResult } from "./grok-acp-client.js";
import { AUTO_CONTINUE_FLOOR_MS, grokTurnTimeoutMs } from "./grok-timeout.js";
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

      const started = Date.now();
      let result = await client.prompt({
        sessionId,
        text: prompt,
        timeoutMs,
        signal: input.signal,
        onProgress: input.onProgress,
      });

      const failure = acpFailureResult(result, sessionId, resumed, timeoutMs);
      if (failure) return failure;

      let projected = projectAcpSuccess({
        result,
        sessionId,
        resumed,
        wantStructured,
      });

      if (wantStructured && shouldAutoContinue(projected)) {
        const remaining = timeoutMs - (Date.now() - started);
        if (remaining < AUTO_CONTINUE_FLOOR_MS) {
          return withIncompleteHint(projected);
        }
        result = await client.prompt({
          sessionId,
          text: CONTINUATION_PROMPT,
          timeoutMs: remaining,
          signal: input.signal,
          onProgress: input.onProgress,
        });
        const continuedFailure = acpFailureResult(
          result,
          sessionId,
          false,
          remaining,
        );
        if (continuedFailure) return continuedFailure;
        projected = projectAcpSuccess({
          result,
          sessionId,
          resumed: true,
          wantStructured,
        });
        if (isIncompletePeerReview(projected)) {
          return withIncompleteHint({ ...projected, resumed: false });
        }
      } else if (wantStructured && projected.incompleteReview) {
        return withIncompleteHint(projected);
      }

      return projected;
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
  // Tools first — do not demand first-token JSON.
  lines.push(
    "Use tools (read_file, grep, list_dir) to inspect the repo before answering. Do not end the turn with a plan to inspect.",
    "",
    body,
  );
  if (options.structured) {
    lines.push(
      "",
      "When the review is finished, prefer a single JSON object matching this schema. Prose is acceptable. No preamble-only turns, no concatenated objects.",
      JSON.stringify(PEER_FINDINGS_JSON_SCHEMA),
    );
  }
  return lines.join("\n");
}

function projectAcpSuccess(options: {
  result: AcpPromptResult;
  sessionId: string;
  resumed: boolean;
  wantStructured: boolean;
}): PeerRunResult {
  const rawText = options.result.text;
  let text = rawText;
  let structured: unknown;
  if (options.wantStructured) {
    structured = lastFindingsObject(rawText);
    if (structured) {
      const pretty = formatStructuredAsText(structured);
      if (pretty) text = pretty;
    }
  }
  const incomplete =
    options.wantStructured &&
    isIncompletePeerReview({ text: rawText, structured });
  return {
    isError: incomplete,
    incompleteReview: incomplete || undefined,
    text,
    stdout: rawText,
    stderr: "",
    nativeSessionId: options.sessionId,
    resumed: options.resumed,
    metrics: options.result.metrics,
    structured,
    progress: options.result.progress,
  };
}

function acpFailureResult(
  result: AcpPromptResult,
  sessionId: string,
  resumed: boolean,
  timeoutMs: number,
): PeerRunResult | undefined {
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
  return undefined;
}

function shouldAutoContinue(result: PeerRunResult): boolean {
  return (
    !result.timedOut &&
    !result.cancelled &&
    Boolean(result.nativeSessionId) &&
    isIncompletePeerReview(result)
  );
}

function withIncompleteHint(result: PeerRunResult): PeerRunResult {
  return {
    ...result,
    isError: true,
    incompleteReview: true,
    continuationHint:
      result.continuationHint ??
      "Incomplete peer review (intent-only stub). Call peer_turn or peer_turn_async with this sessionId, a new idempotency_key, and unchanged expected_version. nativeSessionId is already on the session.",
  };
}
