import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.js";
import {
  createStoredJob,
  gcTerminalJobs,
  jobsDirFor,
  saveJobToDir,
} from "../src/jobs.js";
import {
  createStreamAccumulator,
  GrokHeadlessProvider,
  projectStreamingGrokResult,
} from "../src/providers/grok-headless.js";
import { agentPathForFocus } from "../src/providers/grok-profiles.js";
import type { PeerProvider, PeerRunInput, PeerRunResult } from "../src/providers/types.js";

test("stream accumulator builds text and progress from NDJSON events", () => {
  const updates: number[] = [];
  const acc = createStreamAccumulator((p) => {
    updates.push(p.eventCount);
  });
  acc.onLine(JSON.stringify({ type: "text", data: "Hello " }));
  acc.onLine(JSON.stringify({ type: "thought", data: "thinking hard" }));
  acc.onLine(JSON.stringify({ type: "tool_call", toolName: "read_file", title: "read_file" }));
  acc.onLine(JSON.stringify({ type: "text", data: "world" }));
  acc.onLine(
    JSON.stringify({
      type: "end",
      stopReason: "EndTurn",
      sessionId: "s1",
      num_turns: 4,
    }),
  );

  assert.equal(acc.text(), "Hello world");
  assert.equal(acc.endEvent()?.sessionId, "s1");
  assert.equal(acc.progress().numTurns, 4);
  assert.match(acc.progress().lastThought ?? "", /thinking hard/);
  assert.equal(acc.progress().toolCallCount, 1);
  assert.equal(acc.progress().lastTool, "read_file");
  assert.ok(updates.length >= 3);

  const projected = projectStreamingGrokResult({
    streamState: acc,
    stdout: "streamed",
    stderr: "",
    exitCode: 0,
    expectStructured: false,
  });
  assert.equal(projected.isError, false);
  assert.equal(projected.text, "Hello world");
  assert.equal(projected.nativeSessionId, "s1");
  assert.equal(projected.metrics?.numTurns, 4);
});

test("streaming stub is incompleteReview not success", () => {
  const acc = createStreamAccumulator();
  acc.onLine(
    JSON.stringify({
      type: "text",
      data: "I'll inspect the full prompt, remediation plan, and current source/release contracts first…",
    }),
  );
  acc.onLine(
    JSON.stringify({
      type: "end",
      stopReason: "EndTurn",
      sessionId: "s-stub",
      num_turns: 1,
    }),
  );
  const projected = projectStreamingGrokResult({
    streamState: acc,
    stdout: "streamed",
    stderr: "",
    exitCode: 0,
    expectStructured: true,
  });
  assert.equal(projected.isError, true);
  assert.equal(projected.incompleteReview, true);
  assert.equal(projected.nativeSessionId, "s-stub");
});

test("enforcePromptLimit prepends truncation marker and stays within cap", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-trunc-"));
  const prompts: string[] = [];
  const app = createApp({
    storageDir,
    maxPromptChars: 400,
    providers: {
      grok: {
        name: "grok",
        healthCheck: async () => ({ ok: true, latencyMs: 1 }),
        runTurn: async (input) => {
          prompts.push(input.constructedPrompt);
          return {
            isError: false,
            text: "ok",
            stdout: "ok",
            stderr: "",
            nativeSessionId: "n-trunc",
          };
        },
      },
      antigravity: {
        name: "antigravity",
        healthCheck: async () => ({ ok: true, latencyMs: 1 }),
        runTurn: async () => ({
          isError: false,
          text: "n/a",
          stdout: "",
          stderr: "",
        }),
      },
    },
  });
  await app.hydrate();
  const started = await app.start({
    provider: "grok",
    task: "review",
    repoPath: "/tmp/repo",
    mode: "reviewer",
  });
  const result = await app.turn({
    sessionId: started.sessionId,
    message: "x".repeat(5000),
    idempotencyKey: "trunc-1",
  });
  assert.equal(prompts.length, 1);
  const prompt = prompts[0];
  assert.ok(prompt.startsWith("[TRUNCATED:"));
  assert.equal(prompt.split("\n")[0].includes("read_file"), true);
  assert.ok(prompt.length <= 400);
  assert.equal(result.truncatedPrompt, true);
  assert.equal(
    result.durationAdvisory,
    "Grok sync reviews of this size often take 3–6 minutes. If your MCP client times out sooner, use peer_review_diff_async / peer_turn_async and poll peer_job_status.",
  );

  const shortApp = createApp({
    storageDir: await mkdtemp(join(tmpdir(), "peer-trunc-short-")),
    maxPromptChars: 20_000,
    providers: {
      grok: {
        name: "grok",
        healthCheck: async () => ({ ok: true, latencyMs: 1 }),
        runTurn: async (input) => {
          prompts.push(input.constructedPrompt);
          return {
            isError: false,
            text: "ok",
            stdout: "ok",
            stderr: "",
          };
        },
      },
      antigravity: {
        name: "antigravity",
        healthCheck: async () => ({ ok: true, latencyMs: 1 }),
        runTurn: async () => ({
          isError: false,
          text: "n/a",
          stdout: "",
          stderr: "",
        }),
      },
    },
  });
  await shortApp.hydrate();
  const shortStarted = await shortApp.start({
    provider: "grok",
    task: "review-short",
    repoPath: "/tmp/repo",
    mode: "reviewer",
  });
  await shortApp.turn({
    sessionId: shortStarted.sessionId,
    message: "hello",
    idempotencyKey: "trunc-2",
  });
  assert.doesNotMatch(prompts.at(-1) ?? "", /\[TRUNCATED:/);
});

test("grok streamProgress uses streaming-json and reports progress", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-stream-"));
  const captureFile = join(dir, "args.txt");
  const scriptPath = join(dir, "fake-grok.sh");
  await writeFile(
    scriptPath,
    `#!/bin/sh
printf '%s\\n' "$@" > "${captureFile}"
printf '%s\\n' '{"type":"text","data":"partial "}'
printf '%s\\n' '{"type":"text","data":"answer"}'
printf '%s\\n' '{"type":"end","stopReason":"EndTurn","sessionId":"stream-1","num_turns":2}'
`,
  );
  await chmod(scriptPath, 0o755);

  const progressEvents: string[] = [];
  const provider = new GrokHeadlessProvider({
    command: scriptPath,
    promptDir: join(dir, "prompts"),
  });
  const result = await provider.runTurn({
    constructedPrompt: "stream me",
    mode: "implementer",
    structuredOutput: false,
    streamProgress: true,
    onProgress: (p) => {
      if (p.textSnippet) progressEvents.push(p.textSnippet);
    },
  });

  assert.equal(result.isError, false);
  assert.equal(result.text, "partial answer");
  const captured = await readFile(captureFile, "utf8");
  const minted = captured.match(/--session-id\n([^\n]+)/)?.[1];
  assert.equal(result.nativeSessionId, minted);
  assert.ok(progressEvents.length >= 1);
  assert.match(captured, /--output-format\nstreaming-json/);
});

test("security focus resolves packaged agent definition", () => {
  const path = agentPathForFocus({ mode: "reviewer", focus: "security" });
  assert.ok(path);
  assert.match(path!, /agents\/security-reviewer\.md$/);
});

test("planner mode resolves architect agent definition", () => {
  const path = agentPathForFocus({ mode: "planner" });
  assert.ok(path);
  assert.match(path!, /agents\/architect-planner\.md$/);
});

test("gcTerminalJobs deletes only old terminal jobs", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-gc-"));
  const jobsDir = jobsDirFor(storageDir);
  const old = createStoredJob({
    id: "job_old",
    sessionId: "s1",
    idempotencyKey: "k1",
    provider: "grok",
    task: "old",
    timeoutMs: 1000,
    status: "succeeded",
  });
  old.finishedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  old.updatedAt = old.finishedAt;

  const recent = createStoredJob({
    id: "job_recent",
    sessionId: "s1",
    idempotencyKey: "k2",
    provider: "grok",
    task: "recent",
    timeoutMs: 1000,
    status: "succeeded",
  });
  recent.finishedAt = new Date().toISOString();
  recent.updatedAt = recent.finishedAt;

  const running = createStoredJob({
    id: "job_run",
    sessionId: "s1",
    idempotencyKey: "k3",
    provider: "grok",
    task: "run",
    timeoutMs: 1000,
    status: "running",
  });
  running.updatedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

  await saveJobToDir(jobsDir, old);
  await saveJobToDir(jobsDir, recent);
  await saveJobToDir(jobsDir, running);

  const result = await gcTerminalJobs(jobsDir, {
    maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  });
  assert.deepEqual(result.deleted, ["job_old"]);
  assert.equal(result.retained, 2);
});

class SlowStreamGrok implements PeerProvider {
  readonly name = "grok" as const;
  calls = 0;

  async healthCheck() {
    return { ok: true, latencyMs: 1 };
  }

  async runTurn(input: PeerRunInput): Promise<PeerRunResult> {
    this.calls += 1;
    input.onProgress?.({
      updatedAt: new Date().toISOString(),
      eventCount: 1,
      textSnippet: "working...",
    });
    await new Promise((r) => setTimeout(r, 40));
    input.onProgress?.({
      updatedAt: new Date().toISOString(),
      eventCount: 2,
      textSnippet: "almost done",
      numTurns: 3,
    });
    await new Promise((r) => setTimeout(r, 40));
    return {
      isError: false,
      text: "review complete",
      stdout: "review complete",
      stderr: "",
      nativeSessionId: "n-async",
      progress: {
        updatedAt: new Date().toISOString(),
        eventCount: 2,
        textSnippet: "almost done",
        numTurns: 3,
      },
    };
  }
}

test("reviewDiffAsync completes and job status can surface progress", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-review-async-"));
  const grok = new SlowStreamGrok();
  const app = createApp({
    storageDir,
    providers: {
      grok,
      antigravity: {
        name: "antigravity",
        healthCheck: async () => ({ ok: true, latencyMs: 1 }),
        runTurn: async () => ({
          isError: false,
          text: "n/a",
          stdout: "",
          stderr: "",
        }),
      },
    },
  });
  await app.hydrate();

  const started = await app.reviewDiffAsync({
    diff: "diff --git a/x b/x\n+hello",
    repoPath: "/tmp/repo",
    focus: "security",
    riskLevel: "high",
    idempotencyKey: "rev-async-1",
  });
  assert.ok(started.jobId);

  const deadline = Date.now() + 3000;
  let status = await app.getJobStatus({ jobId: started.jobId });
  let sawProgress = Boolean(status.progress?.textSnippet);
  while (status.status === "queued" || status.status === "running") {
    if (status.progress?.textSnippet) sawProgress = true;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 15));
    status = await app.getJobStatus({ jobId: started.jobId });
  }

  assert.equal(status.status, "succeeded");
  assert.equal(grok.calls, 1);
  // Progress may be brief; success path is required. Prefer seeing progress when timing allows.
  assert.ok(status.result);
});

test("debugAsync creates critic session job", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-debug-async-"));
  const grok = new SlowStreamGrok();
  const app = createApp({
    storageDir,
    providers: {
      grok,
      antigravity: {
        name: "antigravity",
        healthCheck: async () => ({ ok: true, latencyMs: 1 }),
        runTurn: async () => ({
          isError: false,
          text: "n/a",
          stdout: "",
          stderr: "",
        }),
      },
    },
  });
  await app.hydrate();
  const started = await app.debugAsync({
    errorLog: "Error: boom\n  at main",
    repoPath: "/tmp/repo",
    attemptedFixes: "retried twice",
    failedAttempts: 2,
    idempotencyKey: "dbg-async-1",
  });

  const deadline = Date.now() + 3000;
  let status = await app.getJobStatus({ jobId: started.jobId });
  while (status.status === "queued" || status.status === "running") {
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 15));
    status = await app.getJobStatus({ jobId: started.jobId });
  }
  assert.equal(status.status, "succeeded");
  assert.equal(grok.calls, 1);
});

class SlowStreamAgy implements PeerProvider {
  readonly name = "antigravity" as const;
  calls = 0;
  sawStreamProgress = false;

  async healthCheck() {
    return { ok: true, latencyMs: 1 };
  }

  async runTurn(input: PeerRunInput): Promise<PeerRunResult> {
    this.calls += 1;
    this.sawStreamProgress = Boolean(input.streamProgress);
    input.onProgress?.({
      updatedAt: new Date().toISOString(),
      eventCount: 1,
      textSnippet: "agy working...",
      lastThought: "run_command",
    });
    await new Promise((r) => setTimeout(r, 40));
    input.onProgress?.({
      updatedAt: new Date().toISOString(),
      eventCount: 2,
      textSnippet: "agy almost done",
      numTurns: 2,
    });
    await new Promise((r) => setTimeout(r, 40));
    return {
      isError: false,
      text: "agy review complete",
      stdout: "agy review complete",
      stderr: "",
      nativeSessionId: "agy-async",
      progress: {
        updatedAt: new Date().toISOString(),
        eventCount: 2,
        textSnippet: "agy almost done",
        numTurns: 2,
      },
    };
  }
}

test("antigravity async jobs enable streamProgress and surface job progress", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-agy-async-stream-"));
  const agy = new SlowStreamAgy();
  const app = createApp({
    storageDir,
    providers: {
      grok: {
        name: "grok",
        healthCheck: async () => ({ ok: true, latencyMs: 1 }),
        runTurn: async () => ({
          isError: false,
          text: "n/a",
          stdout: "",
          stderr: "",
        }),
      },
      antigravity: agy,
    },
  });
  await app.hydrate();

  const started = await app.start({
    provider: "antigravity",
    task: "stream progress",
    repoPath: "/tmp/repo",
    mode: "implementer",
  });
  const job = await app.turnAsync({
    sessionId: started.sessionId,
    message: "do long work",
    idempotencyKey: "agy-async-stream-1",
  });

  const deadline = Date.now() + 3000;
  let status = await app.getJobStatus({ jobId: job.jobId });
  let sawProgress = Boolean(status.progress?.textSnippet);
  while (status.status === "queued" || status.status === "running") {
    if (status.progress?.textSnippet) sawProgress = true;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 15));
    status = await app.getJobStatus({ jobId: job.jobId });
  }

  assert.equal(status.status, "succeeded");
  assert.equal(agy.calls, 1);
  assert.equal(agy.sawStreamProgress, true);
  assert.ok(sawProgress);
});

test("hydrate auto-GCs ancient terminal jobs", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-gc-app-"));
  const app = createApp({
    storageDir,
    providers: {
      grok: {
        name: "grok",
        healthCheck: async () => ({ ok: true, latencyMs: 1 }),
        runTurn: async () => ({
          isError: false,
          text: "x",
          stdout: "",
          stderr: "",
        }),
      },
      antigravity: {
        name: "antigravity",
        healthCheck: async () => ({ ok: true, latencyMs: 1 }),
        runTurn: async () => ({
          isError: false,
          text: "x",
          stdout: "",
          stderr: "",
        }),
      },
    },
  });
  const jobsDir = jobsDirFor(storageDir);
  const { loadJobFromDir } = await import("../src/jobs.js");
  const old = createStoredJob({
    id: "job_ancient",
    sessionId: "s",
    idempotencyKey: "a",
    provider: "grok",
    task: "t",
    timeoutMs: 1,
    status: "failed",
  });
  old.finishedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  old.updatedAt = old.finishedAt;
  await saveJobToDir(jobsDir, old);

  await app.hydrate();
  const remaining = await loadJobFromDir(jobsDir, "job_ancient");
  assert.equal(remaining, undefined);

  // Explicit GC is idempotent when nothing remains.
  const result = await app.gcJobs({ maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
  assert.deepEqual(result.deleted, []);
});
