import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.js";
import type { PeerProvider, PeerRunResult } from "../src/providers/types.js";

class CountingProvider implements PeerProvider {
  readonly name = "grok" as const;
  calls = 0;

  async healthCheck() {
    return { ok: true, latencyMs: 1 };
  }

  async runTurn(): Promise<PeerRunResult> {
    this.calls += 1;
    return {
      isError: false,
      text: `reply-${this.calls}`,
      stdout: `reply-${this.calls}`,
      stderr: "",
    };
  }
}

test("idempotent retries return the original committed result", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-agents-"));
  const provider = new CountingProvider();
  const app = createApp({
    storageDir,
    providers: { grok: provider, antigravity: provider },
  });
  await app.hydrate();

  const started = await app.start({
    provider: "grok",
    task: "retry test",
    repoPath: "/tmp/demo-repo",
  });

  const first = await app.turn({
    sessionId: started.sessionId,
    message: "hello",
    idempotencyKey: "same-key",
  });
  const second = await app.turn({
    sessionId: started.sessionId,
    message: "hello",
    idempotencyKey: "same-key",
  });

  assert.equal(second.response, first.response);
  assert.equal(second.version, first.version);
  assert.equal(provider.calls, 1);
});