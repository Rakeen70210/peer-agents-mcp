import {
  buildAttachmentManifest,
  classifyAttachments,
  prependAttachmentManifest,
  stageAttachments,
  type AttachmentCleanup,
} from "../attachments.js";
import {
  defaultConversationsDir,
  findNewConversationId,
  listConversationIds,
} from "./antigravity-conversations.js";
import { capabilityProfileForMode } from "./antigravity-profiles.js";
import { effortForRisk } from "./grok-profiles.js";
import {
  formatStructuredAsText,
  PEER_FINDINGS_JSON_SCHEMA,
} from "./grok-schema.js";
import {
  formatGoDuration,
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

export type AntigravityProviderOptions = {
  command?: string;
  baseArgs?: string[];
  timeoutMs?: number;
  /** Override conversations store for native session capture (tests). */
  conversationsDir?: string;
};

export class AntigravityHeadlessProvider implements PeerProvider {
  readonly name = "antigravity" as const;
  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly timeoutMs: number;
  private readonly conversationsDir: string;

  constructor(options: AntigravityProviderOptions = {}) {
    this.command =
      options.command ?? process.env.ANTIGRAVITY_COMMAND ?? "agy";
    const envArgs = parseJsonStringArray(process.env.ANTIGRAVITY_ARGS, "ANTIGRAVITY_ARGS");
    this.baseArgs = options.baseArgs ?? envArgs;
    this.timeoutMs =
      options.timeoutMs ??
      parsePositiveInt(
        process.env.ANTIGRAVITY_TURN_TIMEOUT_MS ??
          process.env.PEER_AGENTS_TURN_TIMEOUT_MS,
        300_000,
      );
    this.conversationsDir =
      options.conversationsDir ?? defaultConversationsDir();
  }

  async healthCheck() {
    const started = Date.now();
    // Prefer a cheap probe over a full agent turn (latency + quota).
    const modelsProbe = await runCommand({
      command: this.command,
      args: ["models"],
      timeoutMs: 15_000,
    });
    if (modelsProbe.exitCode === 0) {
      const detail = stripCliNoise(modelsProbe.stdout).split("\n")[0]?.trim();
      if (detail) {
        return {
          ok: true,
          latencyMs: Date.now() - started,
          detail,
        };
      }
    }

    const result = await this.runTurn({
      constructedPrompt: "Reply with exactly: pong",
      mode: "reviewer",
    });
    return {
      ok: !result.isError && /pong/i.test(result.text),
      latencyMs: Date.now() - started,
      detail: result.isError ? result.stderr || result.text : undefined,
    };
  }

  async runTurn(input: PeerRunInput): Promise<PeerRunResult> {
    let cleanup: AttachmentCleanup | undefined;
    let prompt = input.constructedPrompt;
    const timeoutMs = input.timeoutMs ?? this.timeoutMs;
    const resumeId = input.nativeSessionId?.trim() || undefined;

    // Snapshot conversation ids before cold start so we can capture a new one.
    let beforeIds: Set<string> | undefined;
    if (!resumeId) {
      beforeIds = await listConversationIds(this.conversationsDir);
    }

    try {
      if (input.files?.length && input.cwd) {
        const { binaryFiles } = classifyAttachments(input.files);
        if (binaryFiles.length > 0) {
          const staged = await stageAttachments(input.cwd, binaryFiles);
          cleanup = staged.cleanup;
          const manifest = buildAttachmentManifest(staged.files);
          prompt = prependAttachmentManifest(prompt, manifest);
        }
      }

      const profile = capabilityProfileForMode(input.mode);
      const useStructured =
        input.structuredOutput ??
        (input.mode === "reviewer" || input.mode === "critic");
      const stream = Boolean(input.streamProgress);
      const args = [
        ...stripManagedArgs(this.baseArgs),
        "--print-timeout",
        formatGoDuration(timeoutMs),
        "-p",
        prompt,
        "--dangerously-skip-permissions",
        "--output-format",
        stream ? "stream-json" : "json",
        "--disable-slash-commands",
        ...profile.args,
      ];
      if (resumeId) {
        args.push("--conversation", resumeId);
      }
      if (input.cwd) {
        args.push("--add-dir", input.cwd);
      }
      if (input.model) {
        args.push("--model", input.model);
      }
      if (input.agent?.trim()) {
        args.push("--agent", input.agent.trim());
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
      if (useStructured) {
        args.push("--json-schema", JSON.stringify(PEER_FINDINGS_JSON_SCHEMA));
      }

      const streamState = stream
        ? createAgyStreamAccumulator(input.onProgress)
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
          text: streamState?.text() ?? "",
          stdout: result.stdout,
          stderr: "Antigravity cancelled",
          cancelled: true,
          nativeSessionId: resumeId || streamState?.conversationId(),
          progress: streamState?.progress(),
        };
      }

      if (result.timedOut) {
        return {
          isError: true,
          text: streamState?.text() ?? "",
          stdout: result.stdout,
          stderr: `Antigravity timed out after ${timeoutMs}ms`,
          timedOut: true,
          nativeSessionId: resumeId || streamState?.conversationId(),
          progress: streamState?.progress(),
        };
      }

      const stdout = stripCliNoise(result.stdout);
      const envelope =
        streamState?.resultEvent() ??
        extractAgyResultFromStream(stdout) ??
        extractAgyEnvelope(stdout);
      let nativeSessionId =
        resumeId ||
        envelopeConversationId(envelope) ||
        streamState?.conversationId();
      if (!nativeSessionId && beforeIds) {
        nativeSessionId = await findNewConversationId(
          beforeIds,
          this.conversationsDir,
        );
      }

      if (envelope) {
        return {
          ...projectAgyEnvelope({
            envelope,
            stdout,
            stderr: result.stderr,
            nativeSessionId,
            resumed: Boolean(resumeId),
            expectStructured: useStructured,
          }),
          progress: streamState?.progress(),
        };
      }

      if (result.exitCode === 0 && (streamState?.text() || stdout)) {
        return {
          isError: false,
          text: (streamState?.text() || stdout).trim(),
          stdout,
          stderr: result.stderr,
          nativeSessionId,
          resumed: Boolean(resumeId),
          progress: streamState?.progress(),
        };
      }

      return {
        isError: true,
        text: streamState?.text() ?? stdout,
        stdout,
        stderr: result.stderr || `Antigravity exited with code ${result.exitCode ?? "unknown"}`,
        nativeSessionId: resumeId || streamState?.conversationId(),
        progress: streamState?.progress(),
      };
    } finally {
      await cleanup?.dispose();
    }
  }
}

/** Strip flags the provider injects so ANTIGRAVITY_ARGS cannot double them. */
function stripManagedArgs(args: string[]): string[] {
  const result: string[] = [];
  const valueFlags = new Set([
    "--model",
    "--conversation",
    "--mode",
    "--agent",
    "--print-timeout",
    "--output-format",
    "--json-schema",
    "--effort",
    "-p",
    "--print",
    "--prompt",
    "--add-dir",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (
      arg === "--sandbox" ||
      arg === "--dangerously-skip-permissions" ||
      arg === "--disable-slash-commands"
    ) {
      continue;
    }
    if (valueFlags.has(arg)) {
      index += 1;
      continue;
    }
    if (
      arg.startsWith("--model=") ||
      arg.startsWith("--conversation=") ||
      arg.startsWith("--mode=") ||
      arg.startsWith("--agent=") ||
      arg.startsWith("--print-timeout=") ||
      arg.startsWith("--add-dir=") ||
      arg.startsWith("--output-format=") ||
      arg.startsWith("--json-schema=") ||
      arg.startsWith("--effort=")
    ) {
      continue;
    }
    result.push(arg);
  }
  return result;
}

type AgyEnvelope = {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
  };
  structured_output?: unknown;
};

function extractAgyEnvelope(stdout: string): AgyEnvelope | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const direct = safeJsonParse<AgyEnvelope>(trimmed);
  if (isAgyEnvelope(direct)) return direct;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const nested = safeJsonParse<AgyEnvelope>(trimmed.slice(start, end + 1));
    if (isAgyEnvelope(nested)) return nested;
  }
  return undefined;
}

/** Scan NDJSON for a terminal `result` event (agy `--output-format stream-json`). */
function extractAgyResultFromStream(stdout: string): AgyEnvelope | undefined {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    const parsed = safeJsonParse<AgyStreamLine>(line);
    if (parsed?.event === "result" && parsed.result && isAgyEnvelope(parsed.result)) {
      return parsed.result;
    }
  }
  return undefined;
}

function isAgyEnvelope(value: AgyEnvelope | undefined): value is AgyEnvelope {
  if (!value || typeof value !== "object") return false;
  return (
    value.status !== undefined ||
    value.response !== undefined ||
    value.structured_output !== undefined
  );
}

type AgyStreamStep = {
  conversation_id?: string;
  step_index?: number;
  state?: string;
  step_type?: string;
  tool_name?: string;
  text_delta?: string;
  tool_info?: { name?: string };
};

type AgyStreamLine = {
  event?: string;
  conversation_id?: string;
  step_update?: AgyStreamStep;
  result?: AgyEnvelope;
};

type AgyStreamAccumulator = {
  onLine: (line: string) => void;
  text: () => string;
  progress: () => PeerRunProgress;
  resultEvent: () => AgyEnvelope | undefined;
  conversationId: () => string | undefined;
};

export function createAgyStreamAccumulator(
  onProgress?: (progress: PeerRunProgress) => void,
): AgyStreamAccumulator {
  let text = "";
  let lastThought = "";
  let eventCount = 0;
  let conversationId: string | undefined;
  let resultEvent: AgyEnvelope | undefined;
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
      numTurns: resultEvent?.num_turns,
      stopReason: resultEvent?.status,
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
      const event = safeJsonParse<AgyStreamLine>(line);
      if (!event?.event) {
        emit();
        return;
      }
      if (event.event === "init") {
        conversationId = event.conversation_id?.trim() || conversationId;
      } else if (event.event === "step_update") {
        const step = event.step_update ?? {};
        conversationId = step.conversation_id?.trim() || conversationId;
        const stepType = (step.step_type ?? "").toLowerCase();
        if (typeof step.text_delta === "string" && step.text_delta) {
          if (stepType === "agent_response" || stepType === "") {
            text += step.text_delta;
          } else {
            lastThought = step.text_delta;
          }
        }
        if (stepType === "tool") {
          lastThought = step.tool_name || step.tool_info?.name || lastThought || "tool";
        }
      } else if (event.event === "result" && event.result) {
        resultEvent = event.result;
        conversationId =
          event.result.conversation_id?.trim() || conversationId;
        if (!text.trim() && event.result.response) {
          text = event.result.response;
        }
      }
      emit();
    },
    text: () => text,
    progress: () => lastProgress,
    resultEvent: () => resultEvent,
    conversationId: () => conversationId,
  };
}

function envelopeConversationId(envelope: AgyEnvelope | undefined): string | undefined {
  const id = envelope?.conversation_id?.trim();
  return id || undefined;
}

function projectAgyEnvelope(input: {
  envelope: AgyEnvelope;
  stdout: string;
  stderr: string;
  nativeSessionId?: string;
  resumed: boolean;
  expectStructured: boolean;
}): PeerRunResult {
  const status = (input.envelope.status ?? "SUCCESS").toUpperCase();
  const cancelled = status === "CANCELED" || status === "CANCELLED";
  const isError = cancelled || (status !== "SUCCESS" && status !== "RUNNING");
  const structured =
    input.expectStructured && input.envelope.structured_output
      ? input.envelope.structured_output
      : undefined;
  let text = (input.envelope.response ?? "").trim();
  if (structured) {
    const pretty = formatStructuredAsText(structured);
    if (pretty) text = pretty;
  }
  if (!text && input.envelope.error) text = input.envelope.error;

  return {
    isError,
    text,
    stdout: input.stdout,
    stderr: input.stderr || input.envelope.error || (isError ? status : ""),
    nativeSessionId: input.nativeSessionId,
    resumed: input.resumed,
    cancelled: cancelled || undefined,
    metrics: metricsFromAgyEnvelope(input.envelope),
    structured,
  };
}

function metricsFromAgyEnvelope(envelope: AgyEnvelope): PeerRunMetrics | undefined {
  const usage = envelope.usage;
  if (envelope.num_turns === undefined && !usage) return undefined;
  return {
    numTurns: envelope.num_turns,
    usage: usage
      ? {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          reasoningTokens: usage.thinking_tokens,
          cacheReadInputTokens: usage.cache_read_tokens,
          totalTokens: usage.total_tokens,
        }
      : undefined,
  };
}

function safeJsonParse<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}
