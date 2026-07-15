import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.js";
import type { PeerProvider, PeerRunResult } from "../src/providers/types.js";

class RecordingProvider implements PeerProvider {
  readonly name;
  readonly models: Array<string | undefined> = [];

  constructor(name: "grok" | "antigravity") {
    this.name = name;
  }

  async healthCheck() {
    return { ok: true, latencyMs: 1 };
  }

  async runTurn(input: { model?: string }): Promise<PeerRunResult> {
    this.models.push(input.model);
    return {
      isError: false,
      text: `${this.name}:ok`,
      stdout: `${this.name}:ok`,
      stderr: "",
    };
  }
}

test("routed review uses grok cli default without passing --model", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-agents-"));
  const grok = new RecordingProvider("grok");
  const antigravity = new RecordingProvider("antigravity");
  const app = createApp({
    storageDir,
    providers: { grok, antigravity },
  });
  await app.hydrate();

  const result = await app.routedReviewDiff({
    diff: "diff --git a/foo b/foo",
    repoPath: "/tmp/demo-repo",
    focus: "bugs",
    riskLevel: "low",
    idempotencyKey: "routed-review-1",
  });

  assert.deepEqual(result.routes, ["grok"]);
  assert.equal(result.results.grok?.modelSource, "cli-default");
  assert.equal(grok.models[0], undefined);
  assert.equal(antigravity.models.length, 0);
});

test("routed debate routes coding comparison to Grok only", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-agents-"));
  const grok = new RecordingProvider("grok");
  const antigravity = new RecordingProvider("antigravity");
  const app = createApp({
    storageDir,
    providers: { grok, antigravity },
  });
  await app.hydrate();

  const result = await app.routedDebate({
    task: "pick auth approach",
    planA: "JWT middleware",
    planB: "session cookies",
    repoPath: "/tmp/demo-repo",
    idempotencyKey: "routed-debate-2",
  });

  assert.deepEqual(result.routes, ["grok"]);
  assert.ok(result.results.grok);
  assert.equal(result.results.antigravity, undefined);
  assert.equal(antigravity.models.length, 0);
});

test("with Grok disabled, coding review routes to Antigravity only", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-agents-"));
  const grok = new RecordingProvider("grok");
  const antigravity = new RecordingProvider("antigravity");
  const app = createApp({
    storageDir,
    providers: { grok, antigravity },
    disabledProviders: ["grok"],
  });
  await app.hydrate();

  const health = await app.health();
  assert.deepEqual(health.enabledProviders, ["antigravity"]);
  assert.equal(
    health.providers.find((p) => p.provider === "grok")?.disabled,
    true,
  );

  const result = await app.routedReviewDiff({
    diff: "diff --git a/foo b/foo",
    repoPath: "/tmp/demo-repo",
    focus: "bugs",
    riskLevel: "low",
    idempotencyKey: "routed-review-no-grok-1",
  });

  assert.deepEqual(result.routes, ["antigravity"]);
  assert.ok(result.results.antigravity);
  assert.equal(result.results.grok, undefined);
  assert.equal(grok.models.length, 0);
  assert.equal(antigravity.models.length, 1);
});

test("routed ask routes general knowledge to Antigravity", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-agents-"));
  const grok = new RecordingProvider("grok");
  const antigravity = new RecordingProvider("antigravity");
  const app = createApp({
    storageDir,
    providers: { grok, antigravity },
  });
  await app.hydrate();

  const result = await app.routedAsk({
    question: "What are the tradeoffs of CRDTs vs OT?",
    repoPath: "/tmp/demo-repo",
    idempotencyKey: "routed-ask-1",
  });

  assert.deepEqual(result.routes, ["antigravity"]);
  assert.equal(grok.models.length, 0);
});