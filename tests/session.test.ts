import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.js";
import type { PeerProvider, PeerRunResult } from "../src/providers/types.js";

class FakeProvider implements PeerProvider {
  readonly name;
  private readonly replies: string[];

  constructor(name: "grok" | "antigravity", replies: string[]) {
    this.name = name;
    this.replies = replies;
  }

  async healthCheck() {
    return { ok: true, latencyMs: 1 };
  }

  async runTurn(): Promise<PeerRunResult> {
    const text = this.replies.shift() ?? "done";
    return {
      isError: false,
      text,
      stdout: text,
      stderr: "",
      nativeSessionId: "native-1",
    };
  }
}

test("peer session persists and resumes across app restarts", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peer-agents-"));
  const providers = {
    grok: new FakeProvider("grok", ["first reply", "second reply"]),
    antigravity: new FakeProvider("antigravity", ["ignored"]),
  };

  const app1 = createApp({ storageDir, providers });
  await app1.hydrate();
  const started = await app1.start({
    provider: "grok",
    task: "auth refactor",
    repoPath: "/tmp/demo-repo",
    mode: "implementer",
  });

  const turn1 = await app1.turn({
    sessionId: started.sessionId,
    message: "Review my plan",
    idempotencyKey: "turn-1",
  });
  assert.equal(turn1.response, "first reply");
  assert.equal(turn1.version, 1);

  const app2 = createApp({ storageDir, providers });
  await app2.hydrate();
  const resumed = await app2.start({
    provider: "grok",
    task: "auth refactor",
    repoPath: "/tmp/demo-repo",
    sessionId: started.sessionId,
  });
  assert.equal(resumed.resumed, true);

  const turn2 = await app2.turn({
    sessionId: started.sessionId,
    message: "I fixed issue 1",
    idempotencyKey: "turn-2",
    expectedVersion: 1,
  });
  assert.equal(turn2.response, "second reply");
  assert.equal(turn2.version, 2);

  const raw = await readFile(join(storageDir, `${started.sessionId.replace(/[^a-zA-Z0-9._:-]+/g, "_")}.json`), "utf8");
  const stored = JSON.parse(raw) as { messages: unknown[]; version: number };
  assert.equal(stored.messages.length, 4);
  assert.equal(stored.version, 2);
});