import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentPathForFocus,
  capabilityProfileForMode,
  effortForRisk,
  shouldSelfVerify,
} from "./grok-profiles.js";
import {
  formatStructuredAsText,
  PEER_FINDINGS_JSON_SCHEMA,
} from "./grok-schema.js";
import {
  parseJsonStringArray,
  parsePositiveInt,
  runCommand,
  stripCliNoise,
} from "./runner.js";
import type {
  PeerProvider,
  PeerRunInput,
  PeerRunMetrics,
  PeerRunProgress,
  PeerRunResult,
} from "./types.js";

type GrokJsonResponse = {
  text?: string;
  sessionId?: string;
  error?: string;
  stopReason?: string;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
    reasoning_tokens?: number;
    total_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
  total_cost_usd?: number;
  cost_is_partial?: boolean;
  usage_is_incomplete?: boolean;
  thought?: string;
};

export type GrokProviderOptions = {
  command?: string;
  baseArgs?: string[];
  timeoutMs?: number;
  /** Override prompt staging directory (tests). */
  promptDir?: string;
};

export class GrokHeadlessProvider implements PeerProvider {
  readonly name = "grok" as const;
  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly timeoutMs: number;
  private readonly promptDir: string;

  constructor(options: GrokProviderOptions = {}) {
    this.command = options.command ?? process.env.GROK_COMMAND ?? "grok";
    const envArgs = parseJsonStringArray(process.env.GROK_ARGS, "GROK_ARGS");
    this.baseArgs = options.baseArgs ?? envArgs;
    this.timeoutMs =
      options.timeoutMs ??
      parsePositiveInt(process.env.PEER_AGENTS_TURN_TIMEOUT_MS, 120_000);
    this.promptDir =
      options.promptDir ??
      process.env.PEER_AGENTS_PROMPT_DIR ??
      join(tmpdir(), "peer-agents-prompts");
  }

  async healthCheck() {
    const started = Date.now();
    // Lightweight probe: avoid a full agent turn when `version` works.
    const versionProbe = await runCommand({
      command: this.command,
      args: ["--version"],
      timeoutMs: 15_000,
    });
    if (versionProbe.exitCode === 0 && versionProbe.stdout.trim()) {
      return {
        ok: true,
        latencyMs: Date.now() - started,
        detail: stripCliNoise(versionProbe.stdout).split("\n")[0],
      };
    }

    const result = await this.runTurn({
      constructedPrompt: "Reply with exactly: pong",
      mode: "reviewer",
      structuredOutput: false,
    });
    return {
      ok: !result.isError && /pong/i.test(result.text),
      latencyMs: Date.now() - started,
      detail: result.isError ? result.stderr || result.text : undefined,
    };
  }

  async runTurn(input: PeerRunInput): Promise<PeerRunResult> {
    const timeoutMs = input.timeoutMs ?? this.timeoutMs;
    const resumeId = input.nativeSessionId?.trim() || undefined;
    const requestedWorktree = resolveWorktreeName(input);
    // Only create a worktree on cold start; resume continues the existing tree.
    const worktreeName = resumeId ? undefined : requestedWorktree;

    const result = await this.invokeOnce({
      input,
      timeoutMs,
      resumeId,
      worktreeName,
      allowStructured: true,
    });

    return {
      ...result,
      resumed: Boolean(resumeId) && !result.isError,
      worktreeName: result.worktreeName ?? requestedWorktree,
    };
  }

  private async invokeOnce(options: {
    input: PeerRunInput;
    timeoutMs: number;
    resumeId?: string;
    worktreeName?: string;
    allowStructured: boolean;
  }): Promise<PeerRunResult> {
    const { input, timeoutMs, resumeId, worktreeName } = options;
    const profile = capabilityProfileForMode(input.mode);
    const useStructured =
      options.allowStructured &&
      (input.structuredOutput ?? profile.preferStructuredOutput);
    const stream = Boolean(input.streamProgress);

    const promptPath = await this.writePromptFile(input.constructedPrompt);
    try {
      const args = [
        ...stripModelArgs(this.baseArgs),
        "--prompt-file",
        promptPath,
        "--output-format",
        stream ? "streaming-json" : "json",
        ...profile.args,
      ];

      if (resumeId) {
        args.push("--resume", resumeId);
      }
      if (input.model) {
        args.push("--model", input.model);
      }
      if (input.cwd) {
        args.push("--cwd", input.cwd);
      }
      if (worktreeName) {
        args.push("--worktree", worktreeName);
      }

      const effort = effortForRisk({
        riskLevel: input.riskLevel,
        complexity: input.complexity,
        focus: input.focus,
        mode: input.mode,
      });
      if (effort) {
        args.push("--effort", effort);
      }

      if (
        shouldSelfVerify({
          riskLevel: input.riskLevel,
          focus: input.focus,
          mode: input.mode,
          selfVerify: input.selfVerify,
        })
      ) {
        args.push("--check");
      }

      const agentPath = agentPathForFocus({
        focus: input.focus,
        mode: input.mode,
        agent: input.agent,
      });
      if (agentPath) {
        args.push("--agent", agentPath);
      }

      if (useStructured) {
        args.push("--json-schema", JSON.stringify(PEER_FINDINGS_JSON_SCHEMA));
      }

      // Extra rules for peer independence / role.
      args.push(
        "--rules",
        [
          "You are a peer agent consulted by another coding agent.",
          "Be direct and actionable.",
          "Do not assume you have seen another model's answer.",
        ].join(" "),
      );

      const streamState = stream
        ? createStreamAccumulator(input.onProgress)
        : undefined;

      const result = await runCommand({
        command: this.command,
        args,
        cwd: input.cwd,
        timeoutMs,
        signal: input.signal,
        onStdoutLine: streamState
          ? (line) => streamState.onLine(line)
          : undefined,
      });

      if (result.aborted || input.signal?.aborted) {
        return {
          isError: true,
          text: "",
          stdout: result.stdout,
          stderr: "Grok cancelled",
          cancelled: true,
          worktreeName,
          progress: streamState?.progress(),
        };
      }

      if (result.timedOut) {
        return {
          isError: true,
          text: streamState?.text() ?? "",
          stdout: result.stdout,
          stderr: `Grok timed out after ${timeoutMs}ms`,
          timedOut: true,
          worktreeName,
          progress: streamState?.progress(),
        };
      }

      if (stream && streamState) {
        return projectStreamingGrokResult({
          streamState,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          worktreeName,
          expectStructured: useStructured,
        });
      }

      return projectGrokResult({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        worktreeName,
        expectStructured: useStructured,
      });
    } finally {
      await rm(promptPath, { force: true }).catch(() => undefined);
    }
  }

  private async writePromptFile(prompt: string): Promise<string> {
    await mkdir(this.promptDir, { recursive: true });
    const path = join(this.promptDir, `prompt-${randomUUID()}.txt`);
    await writeFile(path, prompt, "utf8");
    return path;
  }
}

type StreamAccumulator = {
  onLine: (line: string) => void;
  text: () => string;
  progress: () => PeerRunProgress;
  endEvent: () => GrokJsonResponse | undefined;
};

export function createStreamAccumulator(
  onProgress?: (progress: PeerRunProgress) => void,
): StreamAccumulator {
  let text = "";
  let lastThought = "";
  let eventCount = 0;
  let endEvent: GrokJsonResponse | undefined;
  let lastProgress: PeerRunProgress = {
    updatedAt: new Date().toISOString(),
    eventCount: 0,
  };

  const emit = () => {
    lastProgress = {
      updatedAt: new Date().toISOString(),
      eventCount,
      textSnippet: text.slice(-500) || undefined,
      lastThought: lastThought.slice(-400) || undefined,
      numTurns: endEvent?.num_turns,
      stopReason: endEvent?.stopReason,
    };
    try {
      onProgress?.(lastProgress);
    } catch {
      // ignore
    }
  };

  return {
    onLine(line: string) {
      eventCount += 1;
      const event = safeJsonParse<{
        type?: string;
        data?: string;
        stopReason?: string;
        sessionId?: string;
        num_turns?: number;
        usage?: GrokJsonResponse["usage"];
        modelUsage?: Record<string, unknown>;
        total_cost_usd?: number;
        cost_is_partial?: boolean;
        usage_is_incomplete?: boolean;
        message?: string;
      }>(line);
      if (!event?.type) {
        emit();
        return;
      }
      if (event.type === "text" && typeof event.data === "string") {
        text += event.data;
      } else if (event.type === "thought" && typeof event.data === "string") {
        lastThought = event.data;
      } else if (event.type === "end") {
        endEvent = {
          text,
          sessionId: event.sessionId,
          stopReason: event.stopReason,
          num_turns: event.num_turns,
          usage: event.usage,
          modelUsage: event.modelUsage,
          total_cost_usd: event.total_cost_usd,
          cost_is_partial: event.cost_is_partial,
          usage_is_incomplete: event.usage_is_incomplete,
        };
      } else if (event.type === "error") {
        endEvent = {
          error: event.message ?? "stream error",
          sessionId: event.sessionId,
          stopReason: event.stopReason,
          num_turns: event.num_turns,
          usage: event.usage,
        };
      }
      emit();
    },
    text: () => text,
    progress: () => lastProgress,
    endEvent: () => endEvent,
  };
}

export function projectStreamingGrokResult(input: {
  streamState: StreamAccumulator;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  worktreeName?: string;
  expectStructured: boolean;
}): PeerRunResult {
  const end = input.streamState.endEvent();
  const rawText = (end?.text ?? input.streamState.text()).trim();
  const progress = input.streamState.progress();

  if (end?.error) {
    return {
      isError: true,
      text: end.error,
      stdout: input.stdout,
      stderr: input.stderr || end.error,
      nativeSessionId: end.sessionId,
      metrics: metricsFromGrokJson(end),
      worktreeName: input.worktreeName,
      progress,
    };
  }

  if (rawText || input.exitCode === 0) {
    let structured: unknown;
    let text = rawText;
    if (input.expectStructured) {
      structured = tryParseStructured(rawText);
      if (structured) {
        const pretty = formatStructuredAsText(structured);
        if (pretty) text = pretty;
      }
    }
    return {
      isError: false,
      text,
      stdout: input.stdout,
      stderr: input.stderr,
      nativeSessionId: end?.sessionId,
      metrics: metricsFromGrokJson(
        end ?? {
          text: rawText,
          stopReason: progress.stopReason,
          num_turns: progress.numTurns,
        },
      ),
      structured,
      worktreeName: input.worktreeName,
      progress,
    };
  }

  return {
    isError: true,
    text: rawText,
    stdout: input.stdout,
    stderr:
      input.stderr ||
      `Grok exited with code ${input.exitCode ?? "unknown"}`,
    worktreeName: input.worktreeName,
    progress,
  };
}

export function projectGrokResult(input: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  worktreeName?: string;
  expectStructured: boolean;
}): PeerRunResult {
  const stdout = stripCliNoise(input.stdout);
  const parsed = safeJsonParse<GrokJsonResponse>(stdout);
  const metrics = metricsFromGrokJson(parsed);

  if (parsed?.text !== undefined && parsed.text !== null) {
    const rawText = String(parsed.text).trim();
    let structured: unknown;
    let text = rawText;

    if (input.expectStructured) {
      structured = tryParseStructured(rawText);
      if (structured) {
        const pretty = formatStructuredAsText(structured);
        if (pretty) text = pretty;
      }
    }

    return {
      isError: false,
      text,
      stdout,
      stderr: input.stderr,
      nativeSessionId: parsed.sessionId,
      metrics,
      structured,
      worktreeName: input.worktreeName,
    };
  }

  // Error object shape: {"type":"error","message":"..."}
  const errorObj = safeJsonParse<{ type?: string; message?: string; sessionId?: string }>(
    stdout,
  );
  if (errorObj?.type === "error" || parsed?.error) {
    return {
      isError: true,
      text: errorObj?.message ?? parsed?.error ?? stdout,
      stdout,
      stderr: input.stderr || errorObj?.message || parsed?.error || "",
      nativeSessionId: errorObj?.sessionId ?? parsed?.sessionId,
      metrics,
      worktreeName: input.worktreeName,
    };
  }

  if (input.exitCode === 0 && stdout) {
    return {
      isError: false,
      text: stdout,
      stdout,
      stderr: input.stderr,
      metrics,
      worktreeName: input.worktreeName,
    };
  }

  return {
    isError: true,
    text: parsed?.error ?? stdout,
    stdout,
    stderr:
      input.stderr ||
      `Grok exited with code ${input.exitCode ?? "unknown"}`,
    metrics,
    worktreeName: input.worktreeName,
  };
}

export function metricsFromGrokJson(
  parsed: GrokJsonResponse | undefined,
): PeerRunMetrics | undefined {
  if (!parsed) return undefined;
  const hasAny =
    parsed.stopReason !== undefined ||
    parsed.num_turns !== undefined ||
    parsed.usage !== undefined ||
    parsed.total_cost_usd !== undefined ||
    parsed.modelUsage !== undefined;
  if (!hasAny) return undefined;

  return {
    stopReason: parsed.stopReason,
    numTurns: parsed.num_turns,
    usage: parsed.usage
      ? {
          inputTokens: parsed.usage.input_tokens,
          cacheReadInputTokens: parsed.usage.cache_read_input_tokens,
          outputTokens: parsed.usage.output_tokens,
          reasoningTokens: parsed.usage.reasoning_tokens,
          totalTokens: parsed.usage.total_tokens,
        }
      : undefined,
    totalCostUsd: parsed.total_cost_usd,
    costIsPartial: parsed.cost_is_partial,
    usageIsIncomplete: parsed.usage_is_incomplete,
    modelUsage: parsed.modelUsage,
  };
}

function resolveWorktreeName(input: PeerRunInput): string | undefined {
  if (input.worktree === undefined || input.worktree === false) {
    return undefined;
  }
  if (typeof input.worktree === "string" && input.worktree.trim()) {
    return sanitizeWorktreeName(input.worktree.trim());
  }
  return sanitizeWorktreeName(`peer-${randomUUID().slice(0, 8)}`);
}

export function sanitizeWorktreeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 64);
}

/** Heuristic for app-level resume fallback (rebuild full prompt, cold start). */
export function isLikelyResumeFailure(result: PeerRunResult): boolean {
  if (!result.isError || result.timedOut || result.cancelled) return false;
  const blob = `${result.text}\n${result.stderr}\n${result.stdout}`.toLowerCase();
  return (
    blob.includes("resume") ||
    blob.includes("session") ||
    blob.includes("not found") ||
    blob.includes("couldn't start") ||
    blob.includes("could not") ||
    blob.includes("unknown session") ||
    blob.includes("invalid session")
  );
}

function tryParseStructured(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  // Direct JSON object
  if (trimmed.startsWith("{")) {
    const parsed = safeJsonParse<unknown>(trimmed);
    if (parsed && typeof parsed === "object") return parsed;
  }
  // Fenced block
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    const parsed = safeJsonParse<unknown>(fence[1].trim());
    if (parsed && typeof parsed === "object") return parsed;
  }
  return undefined;
}

function stripModelArgs(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-m" || arg === "--model") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--model=")) continue;
    result.push(arg);
  }
  return result;
}

function safeJsonParse<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}
