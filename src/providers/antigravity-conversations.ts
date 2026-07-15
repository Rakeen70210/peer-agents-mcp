import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Default store for agy print-mode SQLite conversations.
 * Override with ANTIGRAVITY_CONVERSATIONS_DIR when needed (tests / custom installs).
 */
export function defaultConversationsDir(): string {
  return (
    process.env.ANTIGRAVITY_CONVERSATIONS_DIR?.trim() ||
    join(homedir(), ".gemini", "antigravity-cli", "conversations")
  );
}

/** List conversation UUIDs from `*.db` basenames (ignore wal/shm sidecars). */
export async function listConversationIds(dir: string): Promise<Set<string>> {
  try {
    const entries = await readdir(dir);
    const ids = new Set<string>();
    for (const name of entries) {
      if (!name.endsWith(".db")) continue;
      // uuid.db only — skip anything that is not a plain .db
      if (name.includes(".db-")) continue;
      ids.add(name.slice(0, -".db".length));
    }
    return ids;
  } catch {
    return new Set();
  }
}

/**
 * Return the sole new conversation id after a turn, or undefined if none/ambiguous.
 * Ambiguous (0 or >1 new files) means we must not attach a native id.
 */
export async function findNewConversationId(
  before: Set<string>,
  dir: string,
): Promise<string | undefined> {
  const after = await listConversationIds(dir);
  const added: string[] = [];
  for (const id of after) {
    if (!before.has(id)) added.push(id);
  }
  if (added.length === 1) return added[0];
  return undefined;
}
