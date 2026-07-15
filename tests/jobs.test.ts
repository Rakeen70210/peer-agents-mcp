import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.js";
import {
  createStoredJob,
  formatJobStatus,
  jobIdFrom,
  jobsDirFor,
  loadJobFromDir,
  saveJobToDir,
} from "../src/jobs.js";
import type { PeerProvider, PeerRunInput, PeerRunResult } from "../src/providers/types.js";

class SlowProvider implements PeerProvider {
  readonly name = "grok" as const;
  calls = 0;
  private readonly delayMs: number;
  private readonly replies: string[];
  private readonly failWith?: "timeout" | "error";

  constructor(options: {
    delayMs?: number;
    replies?: string[];
    failWith?: "timeout" | "error";
  } = {}) {
    this.delayMs = options.delayMs ?? 50;
    this.replies = options.replies ?? ["async-done"];
    this.failWith = options.failWith;
  }

  async healthCheck() {
    return { ok: true, latencyMs: 1 };
  }

  async runTurn(input: PeerRunInput): Promise<PeerRunResult> {
    this.calls += 1;
    const started = Date.now();
    while (Date.now() - started < this.delayMs) {
      if (input.signal?.aborted) {
        return {
          isError: true,
          text: "",
          stdout: "",
          stderr: "cancelled",
          cancelled: true,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (this.failWith === "timeout") {
      return {
        isError: true,
        text: "",
        stdout: "partial",
        stderr: "timed out",
        timedOut: true,
      };
    }
    if (this.failWith === "error") {
      return {
        isError: true,
        text: "provider boom",
        stdout: "",
        stderr: "provider boom",
      };
    }
    const text = this.replies.shift() ?? "done";
    return {
      isError: false,
      text,
      stdout: text,
      stderr: "",
      nativeSessionId: "native-async",
    };
  }
}

class BlockingProvider implements PeerProvider {
  readonly name = "grok" as const;
  calls = 0;
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  async healthCheck() {
    return { ok: true, latencyMs: 1 };
  }

  async runTurn(input: PeerRunInput): Promise<PeerRunResult> {
    this.calls += 1;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        input.signal?.removeEventListener("abort", onAbort);
      };
      if (input.signal?.aborted) {
        resolve();
        return;
      }
      input.signal?.addEventListener("abort", onAbort, { once: true });
      this.gate.then(() => {
        cleanup();
        resolve();
      });
    });
    if (input.signal?.aborted) {
      return {
        isError: true,
        text: "",
        stdout: "",
        stderr: "cancelled",
        cancelled: true,
      };
    }
    return {
      isError: false,
      text: "unblocked",
      stdout: "unblocked",
      stderr: "",
    };
  }

  unblock() {
    this.release();
  }
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJob(
  app: ReturnType<typeof createApp>,
  jobId: string,
  predicate: (status: string) => boolean,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await app.getJobStatus({ jobId });
    if (predicate(status.status)) return status;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

test("job id is deterministic from session and idempotency key", () => {
  const a = jobIdFrom("sess-1", "key-a");
  const b = jobIdFrom("sess-1", "key-a");
  const c = jobIdFrom("sess-1", "key-b");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^job_[a-f0-9]{24}$/);
});

test("job persistence save/load and safe filenames", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-jobs-"));
  const jobsDir = jobsDirFor(storageDir);
  const job = createStoredJob({
    id: "job_abc",
    sessionId: "repo:peer:grok:task",
    idempotencyKey: "k1",
    provider: "grok",
    task: "t",
    timeoutMs: 1000,
  });
  await saveJobToDir(jobsDir, job);
  const loaded = await loadJobFromDir(jobsDir, job.id);
  assert.deepEqual(loaded, job);
  const raw = await readFile(join(jobsDir, "job_abc.json"), "utf8");
  assert.ok(raw.includes('"status": "queued"'));
  const formatted = formatJobStatus(job);
  assert.equal(formatted.jobId, "job_abc");
  assert.equal(formatted.status, "queued");
});

test("async start returns before provider completion and succeeds", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-jobs-"));
  const provider = new SlowProvider({ delayMs: 120, replies: ["long-ok"] });
  const app = createApp({
    storageDir,
    providers: { grok: provider, antigravity: provider },
  });
  await app.hydrate();
  const started = await app.start({
    provider: "grok",
    task: "async mvp",
    repoPath: "/tmp/demo-repo",
    mode: "implementer",
  });

  const t0 = Date.now();
  const job = await app.turnAsync({
    sessionId: started.sessionId,
    message: "do long work",
    idempotencyKey: "async-1",
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 80, `expected quick return, got ${elapsed}ms`);
  assert.ok(job.status === "queued" || job.status === "running");
  assert.equal(job.sessionId, started.sessionId);

  const final = await waitForJob(app, job.jobId, (s) => s === "succeeded");
  assert.equal(final.status, "succeeded");
  assert.equal((final.result as { response: string }).response, "long-ok");
  assert.equal((final.result as { version: number }).version, 1);
  assert.equal(provider.calls, 1);

  const transcript = await app.transcript({ sessionId: started.sessionId });
  assert.equal((transcript.transcript as unknown[]).length, 2);
});

test("duplicate same-key async starts invoke provider once", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-jobs-"));
  const provider = new SlowProvider({ delayMs: 100 });
  const app = createApp({
    storageDir,
    providers: { grok: provider, antigravity: provider },
  });
  await app.hydrate();
  const started = await app.start({
    provider: "grok",
    task: "idempotent async",
    repoPath: "/tmp/demo-repo",
  });

  const first = await app.turnAsync({
    sessionId: started.sessionId,
    message: "work",
    idempotencyKey: "same-async",
  });
  const second = await app.turnAsync({
    sessionId: started.sessionId,
    message: "work",
    idempotencyKey: "same-async",
  });
  assert.equal(first.jobId, second.jobId);

  await waitForJob(app, first.jobId, (s) => s === "succeeded");
  const third = await app.turnAsync({
    sessionId: started.sessionId,
    message: "work",
    idempotencyKey: "same-async",
  });
  assert.equal(third.status, "succeeded");
  assert.equal(provider.calls, 1);
});

test("completed session operation replays as succeeded async job", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-jobs-"));
  const provider = new SlowProvider({ delayMs: 1, replies: ["sync-first"] });
  const app = createApp({
    storageDir,
    providers: { grok: provider, antigravity: provider },
  });
  await app.hydrate();
  const started = await app.start({
    provider: "grok",
    task: "replay",
    repoPath: "/tmp/demo-repo",
  });
  await app.turn({
    sessionId: started.sessionId,
    message: "hello",
    idempotencyKey: "already-done",
  });
  const asyncReplay = await app.turnAsync({
    sessionId: started.sessionId,
    message: "hello",
    idempotencyKey: "already-done",
  });
  assert.equal(asyncReplay.status, "succeeded");
  assert.equal((asyncReplay.result as { response: string }).response, "sync-first");
  assert.equal(provider.calls, 1);
});

test("cancellation marks cancelled and releases session chain", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-jobs-"));
  const provider = new BlockingProvider();
  const app = createApp({
    storageDir,
    providers: { grok: provider, antigravity: provider },
  });
  await app.hydrate();
  const started = await app.start({
    provider: "grok",
    task: "cancel me",
    repoPath: "/tmp/demo-repo",
  });

  const job = await app.turnAsync({
    sessionId: started.sessionId,
    message: "long",
    idempotencyKey: "cancel-1",
  });
  await waitForJob(app, job.jobId, (s) => s === "running");

  const cancelled = await app.cancelJob({ jobId: job.jobId });
  assert.equal(cancelled.status, "cancelled");

  // Chain should advance so a later turn can run.
  provider.unblock();
  await sleep(50);

  const nextProvider = new SlowProvider({ delayMs: 5, replies: ["after-cancel"] });
  // replace provider calls via a fresh app on same storage won't re-run cancelled job
  const app2 = createApp({
    storageDir,
    providers: { grok: nextProvider, antigravity: nextProvider },
  });
  await app2.hydrate();
  const follow = await app2.turn({
    sessionId: started.sessionId,
    message: "next",
    idempotencyKey: "after-cancel",
  });
  assert.equal(follow.response, "after-cancel");
  assert.equal(follow.version, 1);
});

test("async timeout marks timed_out without committing session turn", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-jobs-"));
  const provider = new SlowProvider({ delayMs: 5, failWith: "timeout" });
  const app = createApp({
    storageDir,
    providers: { grok: provider, antigravity: provider },
  });
  await app.hydrate();
  const started = await app.start({
    provider: "grok",
    task: "timeout",
    repoPath: "/tmp/demo-repo",
  });
  const job = await app.turnAsync({
    sessionId: started.sessionId,
    message: "slow",
    idempotencyKey: "timeout-1",
  });
  const final = await waitForJob(app, job.jobId, (s) => s === "timed_out");
  assert.equal(final.status, "timed_out");

  const list = await app.listSessions();
  const session = list.find((s) => s.sessionId === started.sessionId);
  assert.equal(session?.version, 0);
});

test("hydrate does not replace live session with active chain", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-jobs-"));
  const provider = new BlockingProvider();
  const app = createApp({
    storageDir,
    providers: { grok: provider, antigravity: provider },
  });
  await app.hydrate();
  const started = await app.start({
    provider: "grok",
    task: "hydrate safety",
    repoPath: "/tmp/demo-repo",
  });

  const job = await app.turnAsync({
    sessionId: started.sessionId,
    message: "hold",
    idempotencyKey: "hold-1",
  });
  await waitForJob(app, job.jobId, (s) => s === "running");

  // Concurrent hydrate while chain is live should not drop the job chain.
  await app.hydrate();
  const status = await app.getJobStatus({ jobId: job.jobId });
  assert.equal(status.status, "running");

  await app.cancelJob({ jobId: job.jobId });
  provider.unblock();
});

test("persisted running jobs become orphaned after restart", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-jobs-"));
  const jobsDir = jobsDirFor(storageDir);
  const provider = new SlowProvider({ delayMs: 1 });
  const app1 = createApp({
    storageDir,
    providers: { grok: provider, antigravity: provider },
  });
  await app1.hydrate();
  const started = await app1.start({
    provider: "grok",
    task: "orphan",
    repoPath: "/tmp/demo-repo",
  });

  const job = createStoredJob({
    id: jobIdFrom(started.sessionId, "orphan-key"),
    sessionId: started.sessionId,
    idempotencyKey: "orphan-key",
    provider: "grok",
    task: "orphan",
    timeoutMs: 30_000,
    status: "running",
  });
  await saveJobToDir(jobsDir, job);

  const app2 = createApp({
    storageDir,
    providers: { grok: provider, antigravity: provider },
  });
  await app2.hydrate();
  const status = await app2.getJobStatus({ jobId: job.id });
  assert.equal(status.status, "orphaned");
});

test("crash-window recovery: committed op yields synthetic succeeded", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-jobs-"));
  const jobsDir = jobsDirFor(storageDir);
  const provider = new SlowProvider({ delayMs: 1, replies: ["committed"] });
  const app1 = createApp({
    storageDir,
    providers: { grok: provider, antigravity: provider },
  });
  await app1.hydrate();
  const started = await app1.start({
    provider: "grok",
    task: "crash recovery",
    repoPath: "/tmp/demo-repo",
  });
  await app1.turn({
    sessionId: started.sessionId,
    message: "done",
    idempotencyKey: "crash-key",
  });

  // Simulate job file still running while session op already committed.
  const job = createStoredJob({
    id: jobIdFrom(started.sessionId, "crash-key"),
    sessionId: started.sessionId,
    idempotencyKey: "crash-key",
    provider: "grok",
    task: "crash recovery",
    timeoutMs: 30_000,
    status: "running",
  });
  await saveJobToDir(jobsDir, job);

  const app2 = createApp({
    storageDir,
    providers: { grok: provider, antigravity: provider },
  });
  await app2.hydrate();
  const status = await app2.getJobStatus({ jobId: job.id });
  assert.equal(status.status, "succeeded");
  assert.equal((status.result as { response: string }).response, "committed");
  assert.equal(provider.calls, 1);
});

test("expectedVersion conflict at dequeue marks failed without provider call", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-jobs-"));
  const provider = new SlowProvider({ delayMs: 1 });
  const app = createApp({
    storageDir,
    providers: { grok: provider, antigravity: provider },
  });
  await app.hydrate();
  const started = await app.start({
    provider: "grok",
    task: "version conflict",
    repoPath: "/tmp/demo-repo",
  });
  // Bump version first.
  await app.turn({
    sessionId: started.sessionId,
    message: "seed",
    idempotencyKey: "seed",
  });
  const beforeCalls = provider.calls;

  const job = await app.turnAsync({
    sessionId: started.sessionId,
    message: "stale",
    idempotencyKey: "stale-key",
    expectedVersion: 0,
  });
  const final = await waitForJob(app, job.jobId, (s) => s === "failed");
  assert.equal(final.status, "failed");
  assert.match(final.error ?? "", /Version conflict/);
  assert.equal(provider.calls, beforeCalls);
});

test("same-key retry after timed_out is sticky", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-jobs-"));
  const provider = new SlowProvider({ delayMs: 1, failWith: "timeout" });
  const app = createApp({
    storageDir,
    providers: { grok: provider, antigravity: provider },
  });
  await app.hydrate();
  const started = await app.start({
    provider: "grok",
    task: "sticky timeout",
    repoPath: "/tmp/demo-repo",
  });
  const job = await app.turnAsync({
    sessionId: started.sessionId,
    message: "x",
    idempotencyKey: "sticky-to",
  });
  await waitForJob(app, job.jobId, (s) => s === "timed_out");
  const retry = await app.turnAsync({
    sessionId: started.sessionId,
    message: "x",
    idempotencyKey: "sticky-to",
  });
  assert.equal(retry.status, "timed_out");
  assert.equal(provider.calls, 1);
});

test("two different async keys serialize through session chain", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-jobs-"));
  const order: string[] = [];
  class OrderedProvider implements PeerProvider {
    readonly name = "grok" as const;
    private call = 0;
    async healthCheck() {
      return { ok: true, latencyMs: 1 };
    }
    async runTurn(_input: PeerRunInput): Promise<PeerRunResult> {
      this.call += 1;
      const label = this.call === 1 ? "a" : "b";
      order.push(`start-${label}`);
      await sleep(40);
      order.push(`end-${label}`);
      return {
        isError: false,
        text: label,
        stdout: label,
        stderr: "",
      };
    }
  }
  const provider = new OrderedProvider();
  const app = createApp({
    storageDir,
    providers: { grok: provider, antigravity: provider },
  });
  await app.hydrate();
  const started = await app.start({
    provider: "grok",
    task: "serialize",
    repoPath: "/tmp/demo-repo",
  });
  const jobA = await app.turnAsync({
    sessionId: started.sessionId,
    message: "first-msg",
    idempotencyKey: "key-a",
  });
  const jobB = await app.turnAsync({
    sessionId: started.sessionId,
    message: "second-msg",
    idempotencyKey: "key-b",
  });
  await waitForJob(app, jobA.jobId, (s) => s === "succeeded");
  await waitForJob(app, jobB.jobId, (s) => s === "succeeded");
  assert.deepEqual(order, ["start-a", "end-a", "start-b", "end-b"]);
});

test("peer_implement_async creates session and completes job", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-jobs-"));
  const provider = new SlowProvider({ delayMs: 40, replies: ["implemented"] });
  const app = createApp({
    storageDir,
    providers: { grok: provider, antigravity: provider },
  });
  await app.hydrate();

  const t0 = Date.now();
  const job = await app.implementAsync({
    task: "large handoff",
    repoPath: "/tmp/demo-repo",
    message: "implement the feature",
    idempotencyKey: "impl-1",
  });
  assert.ok(Date.now() - t0 < 80);
  assert.ok(job.sessionId);
  assert.ok(job.status === "queued" || job.status === "running");

  const final = await waitForJob(app, job.jobId, (s) => s === "succeeded");
  assert.equal((final.result as { response: string }).response, "implemented");
  assert.equal((final.result as { version: number }).version, 1);

  const sessions = await app.listSessions();
  assert.ok(sessions.some((s) => s.sessionId === job.sessionId && s.mode === "implementer"));
});

test("unknown job status throws", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-jobs-"));
  const provider = new SlowProvider({ delayMs: 1 });
  const app = createApp({
    storageDir,
    providers: { grok: provider, antigravity: provider },
  });
  await app.hydrate();
  await assert.rejects(
    () => app.getJobStatus({ jobId: "job_does_not_exist" }),
    /Unknown job/,
  );
});
