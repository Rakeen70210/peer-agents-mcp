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
import {
  formatGoDuration,
  parseJsonStringArray,
  parsePositiveInt,
  runCommand,
  stripCliNoise,
} from "./runner.js";
import type { PeerProvider, PeerRunInput, PeerRunResult } from "./types.js";

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
      const args = [
        ...stripManagedArgs(this.baseArgs),
        "--print-timeout",
        formatGoDuration(timeoutMs),
        "-p",
        prompt,
        "--dangerously-skip-permissions",
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

      const result = await runCommand({
        command: this.command,
        args,
        cwd: input.cwd,
        timeoutMs,
        signal: input.signal,
      });

      if (result.aborted || input.signal?.aborted) {
        return {
          isError: true,
          text: "",
          stdout: result.stdout,
          stderr: "Antigravity cancelled",
          cancelled: true,
          nativeSessionId: resumeId,
        };
      }

      if (result.timedOut) {
        return {
          isError: true,
          text: "",
          stdout: result.stdout,
          stderr: `Antigravity timed out after ${timeoutMs}ms`,
          timedOut: true,
          nativeSessionId: resumeId,
        };
      }

      const text = stripCliNoise(result.stdout);
      if (result.exitCode === 0 && text) {
        let nativeSessionId = resumeId;
        if (!resumeId && beforeIds) {
          const captured = await findNewConversationId(
            beforeIds,
            this.conversationsDir,
          );
          if (captured) nativeSessionId = captured;
        }
        return {
          isError: false,
          text,
          stdout: text,
          stderr: result.stderr,
          nativeSessionId,
          resumed: Boolean(resumeId),
        };
      }

      return {
        isError: true,
        text,
        stdout: text,
        stderr: result.stderr || `Antigravity exited with code ${result.exitCode ?? "unknown"}`,
        nativeSessionId: resumeId,
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
    "-p",
    "--print",
    "--prompt",
    "--add-dir",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--sandbox" || arg === "--dangerously-skip-permissions") {
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
      arg.startsWith("--add-dir=")
    ) {
      continue;
    }
    result.push(arg);
  }
  return result;
}
