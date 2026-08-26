import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.js";
import type { PeerProvider, PeerRunInput, PeerRunResult } from "../src/providers/types.js";

class RecordingGrok implements PeerProvider {
  readonly name = "grok" as const;
  calls: PeerRunInput[] = [];
  private readonly replies: Array<Partial<PeerRunResult> & { text: string }>;

  constructor(replies: Array<Partial<PeerRunResult> & { text: string }>) {
    this.replies = replies;
  }

  async healthCheck() {
    return { ok: true, latencyMs: 1 };
  }

  async runTurn(input: PeerRunInput): Promise<PeerRunResult> {
    this.calls.push(input);
    const next = this.replies.shift() ?? { text: "done" };
    return {
      isError: next.isError ?? false,
      text: next.text,
      stdout: next.text,
      stderr: next.stderr ?? "",
      nativeSessionId: next.nativeSessionId ?? "native-abc",
      resumed: Boolean(input.nativeSessionId) && !(next.isError ?? false),
      metrics: next.metrics,
      structured: next.structured,
      worktreeName: typeof input.worktree === "string" ? input.worktree : undefined,
      timedOut: next.timedOut,
      cancelled: next.cancelled,
      incompleteReview: next.incompleteReview,
      continuationHint: next.continuationHint,
      progress: next.progress,
    };
  }
}

test("second turn resumes native grok session with compact prompt", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-resume-"));
  const grok = new RecordingGrok([
    { text: "first", nativeSessionId: "native-abc" },
    { text: "second", nativeSessionId: "native-abc" },
  ]);
  const app = createApp({
    storageDir,
    providers: {
      grok,
      antigravity: new RecordingGrok([{ text: "n/a" }]),
    },
  });
  await app.hydrate();

  const started = await app.start({
    provider: "grok",
    task: "review",
    repoPath: "/tmp/repo",
    mode: "reviewer",
  });
  await app.turn({
    sessionId: started.sessionId,
    message: "Please review plan A",
    idempotencyKey: "t1",
  });
  await app.turn({
    sessionId: started.sessionId,
    message: "I fixed issue 1",
    idempotencyKey: "t2",
    expectedVersion: 1,
  });

  assert.equal(grok.calls.length, 2);
  assert.equal(grok.calls[0].nativeSessionId, undefined);
  assert.match(grok.calls[0].constructedPrompt, /acting as a peer agent/);
  assert.equal(grok.calls[1].nativeSessionId, "native-abc");
  assert.match(grok.calls[1].constructedPrompt, /Continue the peer session/);
  assert.doesNotMatch(grok.calls[1].constructedPrompt, /Recent turns:/);
});

test("resume failure falls back to full transcript cold start", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-resume-fail-"));
  const grok = new RecordingGrok([
    { text: "first", nativeSessionId: "native-abc" },
    {
      text: "",
      isError: true,
      stderr: "Couldn't start session: not found",
      nativeSessionId: undefined,
    },
    { text: "recovered", nativeSessionId: "native-new" },
  ]);
  const app = createApp({
    storageDir,
    providers: {
      grok,
      antigravity: new RecordingGrok([{ text: "n/a" }]),
    },
  });
  await app.hydrate();
  const started = await app.start({
    provider: "grok",
    task: "review",
    repoPath: "/tmp/repo",
    mode: "reviewer",
  });
  await app.turn({
    sessionId: started.sessionId,
    message: "first",
    idempotencyKey: "t1",
  });
  const turn2 = await app.turn({
    sessionId: started.sessionId,
    message: "second after crash",
    idempotencyKey: "t2",
    expectedVersion: 1,
  });

  assert.equal(turn2.response, "recovered");
  assert.equal(grok.calls.length, 3);
  assert.equal(grok.calls[1].nativeSessionId, "native-abc");
  assert.equal(grok.calls[2].nativeSessionId, undefined);
  assert.match(grok.calls[2].constructedPrompt, /Recent turns:/);
});

class RecordingAntigravity implements PeerProvider {
  readonly name = "antigravity" as const;
  calls: PeerRunInput[] = [];
  private readonly replies: Array<Partial<PeerRunResult> & { text: string }>;

  constructor(replies: Array<Partial<PeerRunResult> & { text: string }>) {
    this.replies = replies;
  }

  async healthCheck() {
    return { ok: true, latencyMs: 1 };
  }

  async runTurn(input: PeerRunInput): Promise<PeerRunResult> {
    this.calls.push(input);
    const next = this.replies.shift() ?? { text: "done" };
    return {
      isError: next.isError ?? false,
      text: next.text,
      stdout: next.text,
      stderr: next.stderr ?? "",
      nativeSessionId: next.nativeSessionId ?? "agy-conv",
      resumed: Boolean(input.nativeSessionId) && !(next.isError ?? false),
    };
  }
}

test("second antigravity turn resumes native conversation with compact prompt", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-agy-resume-app-"));
  const antigravity = new RecordingAntigravity([
    { text: "first", nativeSessionId: "agy-conv-1" },
    { text: "second", nativeSessionId: "agy-conv-1" },
  ]);

  const app = createApp({
    storageDir,
    providers: {
      grok: new RecordingGrok([{ text: "n/a" }]),
      antigravity,
    },
  });
  await app.hydrate();

  const started = await app.start({
    provider: "antigravity",
    task: "ask",
    repoPath: "/tmp/repo",
    mode: "reviewer",
  });
  await app.turn({
    sessionId: started.sessionId,
    message: "What is X?",
    idempotencyKey: "a1",
  });
  await app.turn({
    sessionId: started.sessionId,
    message: "And Y?",
    idempotencyKey: "a2",
    expectedVersion: 1,
  });

  assert.equal(antigravity.calls.length, 2);
  assert.equal(antigravity.calls[0].nativeSessionId, undefined);
  assert.equal(antigravity.calls[1].nativeSessionId, "agy-conv-1");
  assert.match(antigravity.calls[1].constructedPrompt, /Continue the peer session/);
  assert.doesNotMatch(antigravity.calls[1].constructedPrompt, /Recent turns:/);
});

test("implementAsync sets worktree name on session cold start", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-wt-"));
  const grok = new RecordingGrok([
    { text: "done", nativeSessionId: "n1" },
  ]);
  const app = createApp({
    storageDir,
    providers: {
      grok,
      antigravity: new RecordingGrok([{ text: "n/a" }]),
    },
  });
  await app.hydrate();

  const job = await app.implementAsync({
    task: "ship feature",
    repoPath: "/tmp/repo",
    message: "Implement X",
    idempotencyKey: "impl-1",
  });

  // Wait for background job
  const deadline = Date.now() + 3000;
  let status = await app.getJobStatus({ jobId: job.jobId });
  while (status.status === "queued" || status.status === "running") {
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 20));
    status = await app.getJobStatus({ jobId: job.jobId });
  }

  assert.equal(status.status, "succeeded");
  assert.equal(grok.calls.length, 1);
  assert.equal(typeof grok.calls[0].worktree, "string");
  assert.match(String(grok.calls[0].worktree), /^peer-impl-/);
  assert.equal(grok.calls[0].mode, "implementer");
});

test("stub compare and routedReviewDiff fail closed with continuationHint", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-stub-compare-"));
  const stub = {
    text: "I'll inspect the full prompt first.",
    isError: true,
    incompleteReview: true,
    nativeSessionId: "native-stub",
    continuationHint:
      "Incomplete peer review (intent-only stub). Call peer_turn or peer_turn_async with this sessionId, a new idempotency_key, and unchanged expected_version. nativeSessionId is already on the session.",
  };
  const grok = new RecordingGrok([stub, stub]);
  const app = createApp({
    storageDir,
    providers: {
      grok,
      antigravity: new RecordingGrok([{ text: "n/a" }]),
    },
  });
  await app.hydrate();

  const compared = await app.compare({
    message: "Compare this plan",
    repoPath: "/tmp/repo",
    task: "stub-compare",
    idempotencyKey: "compare-stub-1",
    mode: "reviewer",
    providers: ["grok"],
  });
  assert.equal(compared.allSucceeded, false);
  assert.equal(compared.results.grok?.isError, true);
  assert.equal(compared.results.grok?.incompleteReview, true);
  assert.match(compared.results.grok?.continuationHint ?? "", /idempotency_key/);

  const routed = await app.routedReviewDiff({
    diff: "diff --git a/foo b/foo\n+x",
    repoPath: "/tmp/repo",
    idempotencyKey: "routed-stub-1",
  });
  assert.equal(routed.allSucceeded, false);
  assert.equal(routed.results.grok?.isError, true);
  assert.equal(routed.results.grok?.incompleteReview, true);
  assert.match(routed.results.grok?.continuationHint ?? "", /idempotency_key/);
});

test("incomplete review persists nativeSessionId without assistant transcript", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-stub-persist-"));
  const grok = new RecordingGrok([
    {
      text: "I'll inspect the full prompt first.",
      isError: true,
      incompleteReview: true,
      nativeSessionId: "native-stub",
    },
  ]);
  const app = createApp({
    storageDir,
    providers: {
      grok,
      antigravity: new RecordingGrok([{ text: "n/a" }]),
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
    message: "Please review",
    idempotencyKey: "stub-1",
  });
  assert.equal(result.isError, true);
  assert.equal(result.incompleteReview, true);
  assert.equal(result.nativeSessionId, "native-stub");
  assert.match(result.continuationHint ?? "", /new idempotency_key/);
  assert.match(result.continuationHint ?? "", /expected_version/);

  const transcript = await app.transcript({ sessionId: started.sessionId });
  const messages = transcript.transcript as Array<{ role: string }>;
  assert.equal(messages.filter((message) => message.role === "assistant").length, 0);

  const files = await readdir(storageDir);
  const sessionFile = files.find((file) => file.endsWith(".json"));
  assert.ok(sessionFile);
  const stored = JSON.parse(await readFile(join(storageDir, sessionFile!), "utf8")) as {
    nativeSessionId?: string;
    messages: unknown[];
    version: number;
  };
  assert.equal(stored.nativeSessionId, "native-stub");
  assert.equal(stored.messages.length, 0);
  assert.equal(stored.version, 0);
});
