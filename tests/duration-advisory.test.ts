import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.js";
import type { PeerProvider, PeerRunInput, PeerRunResult } from "../src/providers/types.js";

const ADVISORY =
  "Grok sync reviews of this size often take 3–6 minutes. If your MCP client times out sooner, use peer_review_diff_async / peer_turn_async and poll peer_job_status.";

function fakeGrok(
  extras: Partial<PeerRunResult> = {},
): PeerProvider {
  return {
    name: "grok",
    healthCheck: async () => ({ ok: true, latencyMs: 1 }),
    runTurn: async (input: PeerRunInput): Promise<PeerRunResult> => ({
      isError: false,
      text: extras.text ?? "ok",
      stdout: extras.text ?? "ok",
      stderr: "",
      nativeSessionId:
        extras.nativeSessionId ?? input.assignedSessionId ?? "native-1",
      resumed: extras.resumed,
      timedOut: extras.timedOut,
      cancelled: extras.cancelled,
      incompleteReview: extras.incompleteReview,
      truncatedPrompt: extras.truncatedPrompt,
    }),
  };
}

function fakeAgy(): PeerProvider {
  return {
    name: "antigravity",
    healthCheck: async () => ({ ok: true, latencyMs: 1 }),
    runTurn: async (): Promise<PeerRunResult> => ({
      isError: false,
      text: "agy-ok",
      stdout: "agy-ok",
      stderr: "",
    }),
  };
}

async function appWith(
  grok: PeerProvider,
  options?: { maxPromptChars?: number },
) {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-advisory-"));
  const app = createApp({
    storageDir,
    maxPromptChars: options?.maxPromptChars,
    providers: { grok, antigravity: fakeAgy() },
  });
  await app.hydrate();
  return app;
}

test("ordinary small grok review has no durationAdvisory", async () => {
  const app = await appWith(fakeGrok());
  const result = await app.routedReviewDiff({
    diff: "diff --git a/foo b/foo\n+ok",
    repoPath: "/tmp/demo-repo",
    focus: "bugs",
    riskLevel: "low",
    idempotencyKey: "adv-small",
  });
  assert.equal(result.durationAdvisory, undefined);
  assert.equal(result.results.grok?.durationAdvisory, undefined);
});

test("truncatedPrompt emits durationAdvisory without re-scanning the prompt", async () => {
  const app = await appWith(fakeGrok(), { maxPromptChars: 400 });
  const started = await app.start({
    provider: "grok",
    task: "review",
    repoPath: "/tmp/repo",
    mode: "reviewer",
  });
  const result = await app.turn({
    sessionId: started.sessionId,
    message: "x".repeat(5000),
    idempotencyKey: "adv-trunc",
  });
  assert.equal(result.truncatedPrompt, true);
  assert.equal(result.durationAdvisory, ADVISORY);
});

test("estimated tokens above 20k emit durationAdvisory", async () => {
  const app = await appWith(fakeGrok());
  const started = await app.start({
    provider: "grok",
    task: "review",
    repoPath: "/tmp/repo",
    mode: "reviewer",
  });
  const result = await app.turn({
    sessionId: started.sessionId,
    message: "x".repeat(81_000),
    idempotencyKey: "adv-huge",
  });
  assert.equal(result.truncatedPrompt, false);
  assert.equal(result.durationAdvisory, ADVISORY);
});

test("risk_level=high emits durationAdvisory on routed wrapper and grok result", async () => {
  const app = await appWith(fakeGrok());
  const result = await app.routedReviewDiff({
    diff: "diff --git a/foo b/foo\n+auth",
    repoPath: "/tmp/demo-repo",
    focus: "bugs",
    riskLevel: "high",
    idempotencyKey: "adv-high",
  });
  assert.equal(result.durationAdvisory, ADVISORY);
  assert.equal(result.results.grok?.durationAdvisory, ADVISORY);
});

test("focus=security emits durationAdvisory", async () => {
  const app = await appWith(fakeGrok());
  const result = await app.routedReviewDiff({
    diff: "diff --git a/foo b/foo\n+sec",
    repoPath: "/tmp/demo-repo",
    focus: "security",
    riskLevel: "low",
    idempotencyKey: "adv-sec",
  });
  assert.equal(result.durationAdvisory, ADVISORY);
  assert.equal(result.results.grok?.durationAdvisory, ADVISORY);
});

test("auto-continue (resumed on grok cold start) emits durationAdvisory", async () => {
  const app = await appWith(fakeGrok({ resumed: true, text: "recovered review" }));
  const started = await app.start({
    provider: "grok",
    task: "review",
    repoPath: "/tmp/repo",
    mode: "reviewer",
  });
  const result = await app.turn({
    sessionId: started.sessionId,
    message: "please review",
    idempotencyKey: "adv-autocontinue",
  });
  assert.equal(result.resumed, true);
  assert.equal(result.truncatedPrompt, false);
  assert.equal(result.durationAdvisory, ADVISORY);
});

test("compare copies durationAdvisory onto the grok provider result", async () => {
  const app = await appWith(fakeGrok({ resumed: true }));
  const compared = await app.compare({
    message: "x".repeat(81_000),
    repoPath: "/tmp/demo-repo",
    task: "plan-compare",
    idempotencyKey: "adv-compare",
    providers: ["grok"],
  });
  assert.equal(compared.results.grok?.durationAdvisory, ADVISORY);
  assert.equal(compared.results.antigravity, undefined);
});

test("antigravity-only routes do not get a Grok durationAdvisory", async () => {
  const app = await appWith(fakeGrok());
  const result = await app.routedAsk({
    question: "x".repeat(81_000),
    repoPath: "/tmp/demo-repo",
    idempotencyKey: "adv-ask",
  });
  assert.deepEqual(result.routes, ["antigravity"]);
  assert.equal(result.durationAdvisory, undefined);
  assert.equal(result.results.antigravity?.durationAdvisory, undefined);
});
