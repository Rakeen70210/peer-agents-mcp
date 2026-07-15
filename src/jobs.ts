import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PeerProviderName, PeerRunProgress } from "./providers/types.js";
import { nowIso } from "./state.js";

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "orphaned";

export type StoredJob = {
  id: string;
  sessionId: string;
  idempotencyKey: string;
  provider: PeerProviderName;
  status: JobStatus;
  task: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  timeoutMs: number;
  result?: unknown;
  error?: string;
  /** Live progress while running (streaming providers). */
  progress?: PeerRunProgress;
};

export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "orphaned",
]);

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

export function jobsDirFor(sessionsDir: string): string {
  const base = sessionsDir.endsWith("/sessions")
    ? join(sessionsDir, "..")
    : sessionsDir;
  return join(base, "jobs");
}

/** Deterministic job id from (sessionId, idempotencyKey). */
export function jobIdFrom(sessionId: string, idempotencyKey: string): string {
  const hash = createHash("sha256")
    .update(`${sessionId}\0${idempotencyKey}`)
    .digest("hex")
    .slice(0, 24);
  return `job_${hash}`;
}

export function jobFilePath(jobsDir: string, jobId: string): string {
  const safeId = jobId.replace(/[^a-zA-Z0-9._:-]+/g, "_");
  return join(jobsDir, `${safeId}.json`);
}

export async function ensureJobsDir(jobsDir: string): Promise<void> {
  await mkdir(jobsDir, { recursive: true });
}

export async function saveJobToDir(jobsDir: string, job: StoredJob): Promise<void> {
  await ensureJobsDir(jobsDir);
  const target = jobFilePath(jobsDir, job.id);
  // Unique temp name so concurrent persist/cancel of the same job cannot
  // race on a shared `.tmp` path (ENOENT on rename).
  const temp = `${target}.${randomUUID()}.tmp`;
  const payload = JSON.stringify(job, null, 2);
  await writeFile(temp, payload, "utf8");
  await rename(temp, target);
}

export async function loadJobFromDir(
  jobsDir: string,
  jobId: string,
): Promise<StoredJob | undefined> {
  try {
    const raw = await readFile(jobFilePath(jobsDir, jobId), "utf8");
    return JSON.parse(raw) as StoredJob;
  } catch {
    return undefined;
  }
}

export async function loadAllJobsFromDir(jobsDir: string): Promise<StoredJob[]> {
  try {
    const entries = await readdir(jobsDir);
    const jobs: StoredJob[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry.includes(".tmp")) continue;
      try {
        const raw = await readFile(join(jobsDir, entry), "utf8");
        jobs.push(JSON.parse(raw) as StoredJob);
      } catch {
        // skip corrupt files
      }
    }
    return jobs;
  } catch {
    return [];
  }
}

export async function deleteJobFromDir(
  jobsDir: string,
  jobId: string,
): Promise<void> {
  await rm(jobFilePath(jobsDir, jobId), { force: true });
}

/** Default retention for terminal jobs (7 days). */
export const DEFAULT_JOB_GC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Delete terminal jobs older than maxAgeMs.
 * Non-terminal jobs are never deleted.
 */
export async function gcTerminalJobs(
  jobsDir: string,
  options?: { maxAgeMs?: number; now?: number },
): Promise<{ deleted: string[]; retained: number }> {
  const maxAgeMs = options?.maxAgeMs ?? DEFAULT_JOB_GC_MAX_AGE_MS;
  const now = options?.now ?? Date.now();
  const jobs = await loadAllJobsFromDir(jobsDir);
  const deleted: string[] = [];
  let retained = 0;

  for (const job of jobs) {
    if (!isTerminalJobStatus(job.status)) {
      retained += 1;
      continue;
    }
    const stamp = Date.parse(job.finishedAt ?? job.updatedAt);
    if (!Number.isFinite(stamp) || now - stamp < maxAgeMs) {
      retained += 1;
      continue;
    }
    await deleteJobFromDir(jobsDir, job.id);
    deleted.push(job.id);
  }

  return { deleted, retained };
}

export function createStoredJob(input: {
  id: string;
  sessionId: string;
  idempotencyKey: string;
  provider: PeerProviderName;
  task: string;
  timeoutMs: number;
  status?: JobStatus;
}): StoredJob {
  const now = nowIso();
  return {
    id: input.id,
    sessionId: input.sessionId,
    idempotencyKey: input.idempotencyKey,
    provider: input.provider,
    status: input.status ?? "queued",
    task: input.task,
    createdAt: now,
    updatedAt: now,
    timeoutMs: input.timeoutMs,
  };
}

export type JobStatusResponse = {
  jobId: string;
  sessionId: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  provider: PeerProviderName;
  task: string;
  startedAt?: string;
  finishedAt?: string;
  result?: unknown;
  error?: string;
  progress?: PeerRunProgress;
};

export function formatJobStatus(job: StoredJob): JobStatusResponse {
  const response: JobStatusResponse = {
    jobId: job.id,
    sessionId: job.sessionId,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    provider: job.provider,
    task: job.task,
  };
  if (job.startedAt) response.startedAt = job.startedAt;
  if (job.finishedAt) response.finishedAt = job.finishedAt;
  if (job.status === "succeeded" && job.result !== undefined) {
    response.result = job.result;
  }
  if (job.error) response.error = job.error;
  if (job.progress && (job.status === "running" || job.status === "queued")) {
    response.progress = job.progress;
  }
  return response;
}
