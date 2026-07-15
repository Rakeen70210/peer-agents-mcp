import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GrokAcpClient } from "../src/providers/grok-acp-client.js";
import { GrokAcpPool } from "../src/providers/grok-acp-pool.js";
import { GrokAcpProvider } from "../src/providers/grok-acp-provider.js";
import { createGrokProvider, isGrokAcpTransportEnabled } from "../src/providers/grok-factory.js";
import { GrokHeadlessProvider } from "../src/providers/grok-headless.js";

/**
 * Fake ACP agent: newline JSON-RPC over stdio.
 * Supports initialize, session/new, session/load, session/prompt.
 */
async function writeFakeAcp(dir: string) {
  const script = join(dir, "fake-acp.sh");
  // Node one-liner as fake agent for richer state.
  const agent = join(dir, "fake-acp.mjs");
  await writeFile(
    agent,
    `
import readline from "node:readline";
const sessions = new Set();
let nextId = 1;
const rl = readline.createInterface({ input: process.stdin });
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: {} },
    }});
    return;
  }
  if (msg.method === "session/new") {
    const sessionId = "sess-" + (nextId++);
    sessions.add(sessionId);
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId } });
    return;
  }
  if (msg.method === "session/load") {
    sessions.add(msg.params.sessionId);
    send({ jsonrpc: "2.0", id: msg.id, result: null });
    return;
  }
  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    const text = (msg.params.prompt?.[0]?.text || "").includes("error-please")
      ? ""
      : "peer-ok";
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: sid,
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
    }});
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: sid,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    }});
    send({ jsonrpc: "2.0", id: msg.id, result: {
      stopReason: "end_turn",
      _meta: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    }});
    return;
  }
  if (msg.method === "session/cancel") {
    return;
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found: " + msg.method } });
  }
});
`,
  );
  await writeFile(
    script,
    `#!/bin/sh
# Ignore grok agent flags; run fake agent
exec node "${agent}"
`,
  );
  await chmod(script, 0o755);
  return script;
}

test("createGrokProvider defaults to headless", () => {
  const prev = process.env.PEER_AGENTS_GROK_TRANSPORT;
  delete process.env.PEER_AGENTS_GROK_TRANSPORT;
  try {
    assert.equal(isGrokAcpTransportEnabled(), false);
    assert.ok(createGrokProvider() instanceof GrokHeadlessProvider);
  } finally {
    if (prev === undefined) delete process.env.PEER_AGENTS_GROK_TRANSPORT;
    else process.env.PEER_AGENTS_GROK_TRANSPORT = prev;
  }
});

test("createGrokProvider selects acp when env set", () => {
  const prev = process.env.PEER_AGENTS_GROK_TRANSPORT;
  process.env.PEER_AGENTS_GROK_TRANSPORT = "acp";
  try {
    assert.equal(isGrokAcpTransportEnabled(), true);
    assert.ok(createGrokProvider() instanceof GrokAcpProvider);
  } finally {
    if (prev === undefined) delete process.env.PEER_AGENTS_GROK_TRANSPORT;
    else process.env.PEER_AGENTS_GROK_TRANSPORT = prev;
  }
});

test("ACP client createSession + prompt reuses process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-acp-"));
  const command = await writeFakeAcp(dir);
  const client = new GrokAcpClient({
    command,
    idleTimeoutMs: 60_000,
  });
  try {
    const sid = await client.createSession(dir);
    assert.match(sid, /^sess-/);
    const first = await client.prompt({
      sessionId: sid,
      text: "hello",
      timeoutMs: 5_000,
    });
    assert.equal(first.isError, undefined);
    assert.equal(first.text, "peer-ok");
    assert.equal(first.metrics?.usage?.totalTokens, 12);

    const second = await client.prompt({
      sessionId: sid,
      text: "again",
      timeoutMs: 5_000,
    });
    assert.equal(second.text, "peer-ok");
    assert.ok(client.liveSessions.has(sid));
  } finally {
    await client.dispose();
  }
});

test("ACP pool reuses client per cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-acp-pool-"));
  const command = await writeFakeAcp(dir);
  const pool = new GrokAcpPool({
    command,
    maxClients: 2,
    idleTimeoutMs: 60_000,
  });
  try {
    const a = await pool.getClient(dir);
    const b = await pool.getClient(dir);
    assert.equal(a, b);
    assert.equal(pool.size, 1);
    const sid = await a.createSession(dir);
    assert.equal(pool.findClientForSession(sid), a);
  } finally {
    await pool.disposeAll();
  }
});

test("GrokAcpProvider multi-turn resumes session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-acp-prov-"));
  const command = await writeFakeAcp(dir);
  const pool = new GrokAcpPool({ command, idleTimeoutMs: 60_000 });
  const provider = new GrokAcpProvider({ pool, timeoutMs: 5_000 });
  try {
    const t1 = await provider.runTurn({
      constructedPrompt: "first",
      cwd: dir,
      mode: "reviewer",
      structuredOutput: false,
    });
    assert.equal(t1.isError, false);
    assert.equal(t1.text, "peer-ok");
    assert.ok(t1.nativeSessionId);
    assert.equal(t1.resumed, false);

    const t2 = await provider.runTurn({
      constructedPrompt: "second",
      cwd: dir,
      mode: "reviewer",
      structuredOutput: false,
      nativeSessionId: t1.nativeSessionId,
    });
    assert.equal(t2.isError, false);
    assert.equal(t2.resumed, true);
    assert.equal(t2.nativeSessionId, t1.nativeSessionId);
  } finally {
    await pool.disposeAll();
  }
});
