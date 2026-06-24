import {
  buildAttachmentManifest,
  classifyAttachments,
  prependAttachmentManifest,
  stageAttachments,
  type AttachmentCleanup,
} from "../attachments.js";
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
};

export class AntigravityHeadlessProvider implements PeerProvider {
  readonly name = "antigravity" as const;
  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly timeoutMs: number;

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
  }

  async healthCheck() {
    const started = Date.now();
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

      const args = [
        ...stripModelArgs(this.baseArgs),
        "--print-timeout",
        formatGoDuration(this.timeoutMs),
        "-p",
        prompt,
        "--dangerously-skip-permissions",
      ];
      if (input.cwd) {
        args.push("--add-dir", input.cwd);
      }
      if (input.model) {
        args.push("--model", input.model);
      }

      const result = await runCommand({
        command: this.command,
        args,
        cwd: input.cwd,
        timeoutMs: this.timeoutMs,
      });

      if (result.timedOut) {
        return {
          isError: true,
          text: "",
          stdout: result.stdout,
          stderr: `Antigravity timed out after ${this.timeoutMs}ms`,
        };
      }

      const text = stripCliNoise(result.stdout);
      if (result.exitCode === 0 && text) {
        return {
          isError: false,
          text,
          stdout: text,
          stderr: result.stderr,
        };
      }

      return {
        isError: true,
        text,
        stdout: text,
        stderr: result.stderr || `Antigravity exited with code ${result.exitCode ?? "unknown"}`,
      };
    } finally {
      await cleanup?.dispose();
    }
  }
}

function stripModelArgs(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--model") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--model=")) continue;
    result.push(arg);
  }
  return result;
}