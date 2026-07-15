import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { RoutedProvider } from "./catalog.js";
import type { PeerMode, PeerProviderName } from "./providers/types.js";

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
  createdAt: string;
  participant?: string;
};

export type StoredOperation = {
  idempotencyKey: string;
  committedAt: string;
  result: unknown;
};

export type StoredSession = {
  id: string;
  provider: PeerProviderName;
  routedProvider?: RoutedProvider;
  model?: string;
  task: string;
  repoPath: string;
  mode: PeerMode;
  system?: string;
  summary?: string;
  messages: ChatMessage[];
  version: number;
  nativeSessionId?: string;
  /** Grok worktree name for implementer isolation (set once at session create). */
  worktreeName?: string;
  createdAt: string;
  updatedAt: string;
  operations: StoredOperation[];
};

export type Session = StoredSession & {
  chain: Promise<unknown>;
};

export function defaultStorageDir(): string {
  return (
    process.env.PEER_AGENTS_STORAGE_DIR ??
    join(homedir(), ".peer-agents", "sessions")
  );
}

export function comparisonsDirFor(sessionsDir: string): string {
  const base = sessionsDir.endsWith("/sessions")
    ? join(sessionsDir, "..")
    : sessionsDir;
  return join(base, "comparisons");
}

export function defaultComparisonsDir(): string {
  return comparisonsDirFor(defaultStorageDir());
}

export async function saveComparisonToDir(
  comparisonsDir: string,
  idempotencyKey: string,
  result: unknown,
): Promise<void> {
  await mkdir(comparisonsDir, { recursive: true });
  const safeKey = idempotencyKey.replace(/[^a-zA-Z0-9._:-]+/g, "_");
  const target = join(comparisonsDir, `${safeKey}.json`);
  const temp = `${target}.tmp`;
  const payload = JSON.stringify(
    { idempotencyKey, committedAt: nowIso(), result },
    null,
    2,
  );
  await writeFile(temp, payload, "utf8");
  await rename(temp, target);
}

export async function loadComparisonFromDir(
  comparisonsDir: string,
  idempotencyKey: string,
): Promise<unknown | undefined> {
  try {
    const safeKey = idempotencyKey.replace(/[^a-zA-Z0-9._:-]+/g, "_");
    const raw = await readFile(join(comparisonsDir, `${safeKey}.json`), "utf8");
    const parsed = JSON.parse(raw) as { result?: unknown };
    return parsed.result;
  } catch {
    return undefined;
  }
}

export function toStoredSession(session: Session): StoredSession {
  const { chain: _chain, ...stored } = session;
  return stored;
}

export function fromStoredSession(stored: StoredSession): Session {
  return { ...stored, chain: Promise.resolve() };
}

export async function ensureStorageDir(storageDir: string): Promise<void> {
  await mkdir(storageDir, { recursive: true });
}

export function sessionFilePath(storageDir: string, sessionId: string): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9._:-]+/g, "_");
  return join(storageDir, `${safeId}.json`);
}

export async function saveSessionToDir(
  storageDir: string,
  session: Session,
): Promise<void> {
  await ensureStorageDir(storageDir);
  const target = sessionFilePath(storageDir, session.id);
  const temp = `${target}.tmp`;
  const payload = JSON.stringify(toStoredSession(session), null, 2);
  await writeFile(temp, payload, "utf8");
  await rename(temp, target);
}

export async function loadSessionFromDir(
  storageDir: string,
  sessionId: string,
): Promise<Session | undefined> {
  try {
    const raw = await readFile(sessionFilePath(storageDir, sessionId), "utf8");
    return fromStoredSession(JSON.parse(raw) as StoredSession);
  } catch {
    return undefined;
  }
}

export async function loadAllSessionsFromDir(storageDir: string): Promise<Session[]> {
  try {
    const entries = await readdir(storageDir);
    const sessions: Session[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry.endsWith(".tmp")) continue;
      try {
        const raw = await readFile(join(storageDir, entry), "utf8");
        sessions.push(fromStoredSession(JSON.parse(raw) as StoredSession));
      } catch {
        // skip corrupt files
      }
    }
    return sessions;
  } catch {
    return [];
  }
}

export async function deleteSessionFromDir(
  storageDir: string,
  sessionId: string,
): Promise<void> {
  await rm(sessionFilePath(storageDir, sessionId), { force: true });
}

export function createSession(input: {
  id: string;
  provider: PeerProviderName;
  routedProvider?: RoutedProvider;
  model?: string;
  task: string;
  repoPath: string;
  mode: PeerMode;
  system?: string;
  worktreeName?: string;
}): Session {
  const now = nowIso();
  return {
    id: input.id,
    provider: input.provider,
    routedProvider: input.routedProvider,
    model: input.model,
    task: input.task,
    repoPath: input.repoPath,
    mode: input.mode,
    system: input.system,
    worktreeName: input.worktreeName,
    summary: "",
    messages: [],
    version: 0,
    createdAt: now,
    updatedAt: now,
    operations: [],
    chain: Promise.resolve(),
  };
}

export function getCommittedOperationResult<T>(
  session: Session,
  idempotencyKey: string,
): T | undefined {
  const match = session.operations.find((op) => op.idempotencyKey === idempotencyKey);
  return match?.result as T | undefined;
}

export function beginOperation(session: Session, idempotencyKey: string): void {
  const existing = getCommittedOperationResult(session, idempotencyKey);
  if (existing !== undefined) return;
}

export function commitOperation(
  session: Session,
  idempotencyKey: string,
  result: unknown,
): void {
  const existing = session.operations.find((op) => op.idempotencyKey === idempotencyKey);
  if (existing) {
    existing.result = result;
    existing.committedAt = nowIso();
    return;
  }
  session.operations.push({
    idempotencyKey,
    committedAt: nowIso(),
    result,
  });
}

export function assertExpectedVersion(
  session: Session,
  expectedVersion?: number,
): void {
  if (expectedVersion === undefined) return;
  if (session.version !== expectedVersion) {
    throw new Error(
      `Version conflict: expected ${expectedVersion}, current ${session.version}`,
    );
  }
}

export function recentMessages(session: Session, maxTurns = 8): ChatMessage[] {
  return session.messages.slice(-maxTurns * 2);
}

export function nowIso(): string {
  return new Date().toISOString();
}