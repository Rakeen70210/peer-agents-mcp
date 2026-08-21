import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function sanitizeWorktreeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 64);
}

export function defaultWorktreeRoot(): string {
  return (
    process.env.PEER_AGENTS_WORKTREE_DIR?.trim() ||
    join(homedir(), ".peer-agents", "worktrees")
  );
}

export function worktreePathFor(
  repoPath: string,
  name: string,
  root?: string,
): string {
  const base = root?.trim() || defaultWorktreeRoot();
  const hash = createHash("sha256")
    .update(resolve(repoPath))
    .digest("hex")
    .slice(0, 12);
  return join(base, hash, sanitizeWorktreeName(name));
}

/**
 * Create (or reuse) a git worktree for headless Grok isolation.
 * Grok 1.0 does not create worktrees from `--worktree` in headless mode.
 * Returns undefined when cwd is not a git repo or `git worktree add` fails.
 */
export async function ensurePeerWorktree(input: {
  repoPath: string;
  name: string;
  root?: string;
}): Promise<string | undefined> {
  const repo = resolve(input.repoPath);
  const dest = worktreePathFor(repo, input.name, input.root);
  if (existsSync(dest)) return dest;

  try {
    await execFileAsync(
      "git",
      ["-C", repo, "rev-parse", "--is-inside-work-tree"],
      { timeout: 10_000 },
    );
  } catch {
    return undefined;
  }

  await mkdir(dirname(dest), { recursive: true });
  try {
    await execFileAsync(
      "git",
      ["-C", repo, "worktree", "add", "--detach", dest, "HEAD"],
      { timeout: 30_000 },
    );
    return dest;
  } catch {
    return existsSync(dest) ? dest : undefined;
  }
}
