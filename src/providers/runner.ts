import { spawn } from "node:child_process";

export type SpawnResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
};

export async function runCommand(options: {
  command: string;
  args: string[];
  cwd?: string;
  stdin?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<SpawnResult> {
  if (options.signal?.aborted) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "Aborted before start",
      timedOut: false,
      aborted: true,
    };
  }

  return new Promise((resolve) => {
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group so timeout/cancel can kill grandchildren without
      // signalling the MCP server process group.
      detached: useProcessGroup,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const finish = (result: SpawnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const killChild = () => {
      if (!child.pid) {
        try {
          child.kill("SIGTERM");
        } catch {
          // already dead
        }
        return;
      }
      try {
        if (useProcessGroup) {
          process.kill(-child.pid, "SIGTERM");
          setTimeout(() => {
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch {
              // already dead
            }
          }, 2000).unref();
        } else {
          child.kill("SIGTERM");
          setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // already dead
            }
          }, 2000).unref();
        }
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          // already dead
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, options.timeoutMs);

    const onAbort = () => {
      aborted = true;
      killChild();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("close", (exitCode) => {
      finish({ exitCode, stdout, stderr, timedOut, aborted });
    });

    child.on("error", (error) => {
      finish({
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        timedOut,
        aborted,
      });
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

export function parseJsonStringArray(value: string | undefined, envName: string): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      throw new Error("Expected a JSON array of strings");
    }
    return parsed;
  } catch {
    throw new Error(`Invalid ${envName}. Expected JSON like: ["--model","grok-build"]`);
  }
}

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function formatGoDuration(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    return `${ms / 60_000}m`;
  }
  return `${Math.max(1, Math.ceil(ms / 1000))}s`;
}

export function stripCliNoise(text: string): string {
  if (!text) return "";
  return text
    .split("\n")
    .filter((line) => !/^\s*Loaded cached credentials\.?\s*$/i.test(line))
    .join("\n")
    .trim();
}
