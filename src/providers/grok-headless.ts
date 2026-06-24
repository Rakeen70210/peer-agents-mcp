import {
  parseJsonStringArray,
  parsePositiveInt,
  runCommand,
  stripCliNoise,
} from "./runner.js";
import type { PeerProvider, PeerRunInput, PeerRunResult } from "./types.js";

type GrokJsonResponse = {
  text?: string;
  sessionId?: string;
  error?: string;
};

export type GrokProviderOptions = {
  command?: string;
  baseArgs?: string[];
  timeoutMs?: number;
};

export class GrokHeadlessProvider implements PeerProvider {
  readonly name = "grok" as const;
  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly timeoutMs: number;

  constructor(options: GrokProviderOptions = {}) {
    this.command = options.command ?? process.env.GROK_COMMAND ?? "grok";
    const envArgs = parseJsonStringArray(process.env.GROK_ARGS, "GROK_ARGS");
    this.baseArgs = options.baseArgs ?? envArgs;
    this.timeoutMs =
      options.timeoutMs ??
      parsePositiveInt(process.env.PEER_AGENTS_TURN_TIMEOUT_MS, 120_000);
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
    const args = [
      ...stripModelArgs(this.baseArgs),
      "-p",
      input.constructedPrompt,
      "--output-format",
      "json",
      "--always-approve",
    ];
    if (input.model) {
      args.push("--model", input.model);
    }
    if (input.cwd) {
      args.push("--cwd", input.cwd);
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
        stderr: `Grok timed out after ${this.timeoutMs}ms`,
      };
    }

    const stdout = stripCliNoise(result.stdout);
    const parsed = safeJsonParse<GrokJsonResponse>(stdout);
    if (parsed?.text) {
      return {
        isError: false,
        text: parsed.text.trim(),
        stdout,
        stderr: result.stderr,
        nativeSessionId: parsed.sessionId,
      };
    }

    if (result.exitCode === 0 && stdout) {
      return {
        isError: false,
        text: stdout,
        stdout,
        stderr: result.stderr,
      };
    }

    return {
      isError: true,
      text: parsed?.error ?? stdout,
      stdout,
      stderr: result.stderr || `Grok exited with code ${result.exitCode ?? "unknown"}`,
    };
  }
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