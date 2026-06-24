import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.js";
import type { PeerProvider, PeerRunResult } from "../src/providers/types.js";

class TaggedProvider implements PeerProvider {
  readonly name;
  calls = 0;

  constructor(name: "grok" | "antigravity") {
    this.name = name;
  }

  async healthCheck() {
    return { ok: true, latencyMs: 1 };
  }

  async runTurn(): Promise<PeerRunResult> {
    this.calls += 1;
    await new Promise((resolve) => setTimeout(resolve, this.name === "grok" ? 20 : 5));
    return {
      isError: false,
      text: `${this.name}-answer`,
      stdout: `${this.name}-answer`,
      stderr: "",
    };
  }
}

test("peer_compare runs providers in parallel and persists idempotent replay", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-agents-"));
  process.env.PEER_AGENTS_STORAGE_DIR = storageDir;

  const grok = new TaggedProvider("grok");
  const antigravity = new TaggedProvider("antigravity");
  const app = createApp({
    storageDir,
    providers: { grok, antigravity },
  });
  await app.hydrate();

  const startedAt = Date.now();
  const first = await app.compare({
    message: "Compare this plan",
    repoPath: "/tmp/demo-repo",
    task: "plan-compare",
    idempotencyKey: "compare-1",
    mode: "reviewer",
    parallel: true,
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(first.providers.length, 2);
  assert.equal(first.results.grok?.response, "grok-answer");
  assert.equal(first.results.antigravity?.response, "antigravity-answer");
  assert.equal(first.allSucceeded, true);
  assert.equal(grok.calls, 1);
  assert.equal(antigravity.calls, 1);
  assert.ok(elapsed < 40, "expected parallel execution");

  grok.calls = 0;
  antigravity.calls = 0;
  const second = await app.compare({
    message: "Compare this plan",
    repoPath: "/tmp/demo-repo",
    task: "plan-compare",
    idempotencyKey: "compare-1",
  });
  assert.equal(second.idempotencyKey, first.idempotencyKey);
  assert.equal(second.results.grok?.response, first.results.grok?.response);
  assert.equal(second.results.antigravity?.response, first.results.antigravity?.response);
  assert.equal(grok.calls, 0);
  assert.equal(antigravity.calls, 0);

  delete process.env.PEER_AGENTS_STORAGE_DIR;
});

test("peer_compare supports partial provider selection", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-agents-"));
  const grok = new TaggedProvider("grok");
  const antigravity = new TaggedProvider("antigravity");
  const app = createApp({
    storageDir,
    providers: { grok, antigravity },
  });
  await app.hydrate();

  const result = await app.compare({
    message: "Only grok",
    repoPath: "/tmp/demo-repo",
    task: "grok-only",
    providers: ["grok"],
    idempotencyKey: "compare-grok-only",
  });

  assert.deepEqual(result.providers, ["grok"]);
  assert.equal(result.results.grok?.response, "grok-answer");
  assert.equal(result.results.antigravity, undefined);
  assert.equal(antigravity.calls, 0);
});