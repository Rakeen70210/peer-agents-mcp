import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GrokAcpClient } from "../src/providers/grok-acp-client.js";
import { GrokAcpPool } from "../src/providers/grok-acp-pool.js";
import { GrokAcpProvider } from "../src/providers/grok-acp-provider.js";
import { createGrokProvider, isGrokAcpTransportEnabled } from "../src/providers/grok-factory.js";
import { GrokHeadlessProvider } from "../src/providers/grok-headless.js";
import {
  DEFAULT_GROK_TURN_TIMEOUT_MS,
  grokTurnTimeoutMs,
} from "../src/providers/grok-timeout.js";

/**
 * Fake ACP agent: newline JSON-RPC over stdio.
 * Supports initialize, session/new, session/load, session/prompt.
 */
async function writeFakeAcp(
  dir: string,
  options?: { promptDelayMs?: number; emitToolCall?: boolean; cancelFile?: string },
) {
  const script = join(dir, "fake-acp.sh");
  // Node one-liner as fake agent for richer state.
  const agent = join(dir, "fake-acp.mjs");
  await writeFile(
    agent,
    `
import readline from "node:readline";
import { appendFileSync } from "node:fs";
const sessions = new Set();
let nextId = 1;
const cancelFile = ${JSON.stringify(options?.cancelFile ?? "")};
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
    const delay = ${options?.promptDelayMs ?? 0};
    const emitTool = ${options?.emitToolCall ? "true" : "false"};
    const text = (msg.params.prompt?.[0]?.text || "").includes("error-please")
      ? ""
      : "peer-ok";
    const finish = () => {
      send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId: sid,
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
      }});
      if (emitTool) {
        send({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: sid,
          update: { sessionUpdate: "tool_call", toolName: "read_file", title: "read_file" },
        }});
      }
      send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId: sid,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      }});
      send({ jsonrpc: "2.0", id: msg.id, result: {
        stopReason: "end_turn",
        _meta: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      }});
    };
    if (delay > 0) setTimeout(finish, delay);
    else finish();
    return;
  }
  if (msg.method === "session/cancel") {
    if (cancelFile) {
      appendFileSync(cancelFile, "CANCEL " + (msg.params?.sessionId || "") + "\\n");
    }
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

test("ACP assignedSessionId is ignored; createSession id is used", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-acp-assigned-"));
  const command = await writeFakeAcp(dir);
  const pool = new GrokAcpPool({ command, idleTimeoutMs: 60_000 });
  const provider = new GrokAcpProvider({ pool, timeoutMs: 5_000 });
  try {
    const persisted: string[] = [];
    const result = await provider.runTurn({
      constructedPrompt: "first",
      cwd: dir,
      mode: "reviewer",
      structuredOutput: false,
      assignedSessionId: "minted-uuid",
      onNativeSessionId: (id) => {
        persisted.push(id);
      },
    });
    assert.notEqual(result.nativeSessionId, "minted-uuid");
    assert.match(result.nativeSessionId ?? "", /^sess-/);
    assert.deepEqual(persisted, [result.nativeSessionId]);
  } finally {
    await pool.disposeAll();
  }
});

test("ACP idle 200ms does not dispose an in-flight 1s prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-acp-idle-"));
  const command = await writeFakeAcp(dir, { promptDelayMs: 1000 });
  const client = new GrokAcpClient({ command, idleTimeoutMs: 200 });
  try {
    const sid = await client.createSession(dir);
    const started = Date.now();
    const result = await client.prompt({
      sessionId: sid,
      text: "hello",
      timeoutMs: 5_000,
    });
    const elapsed = Date.now() - started;
    assert.equal(result.isError, undefined);
    assert.equal(result.text, "peer-ok");
    assert.ok(elapsed >= 900, `prompt returned too fast (${elapsed}ms)`);
    assert.equal(client.isAlive, true);
  } finally {
    await client.dispose();
  }
});

test("ACP job-length prompt with idle 200ms does not dispose while in flight", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-acp-idle-job-"));
  const command = await writeFakeAcp(dir, { promptDelayMs: 1500 });
  const client = new GrokAcpClient({ command, idleTimeoutMs: 200 });
  try {
    const sid = await client.createSession(dir);
    const result = await client.prompt({
      sessionId: sid,
      text: "long job",
      timeoutMs: 30_000,
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.text, "peer-ok");
    assert.equal(client.isAlive, true);
  } finally {
    await client.dispose();
  }
});

test("ACP collector increments toolCallCount on tool-call updates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-acp-tools-"));
  const command = await writeFakeAcp(dir, { emitToolCall: true });
  const pool = new GrokAcpPool({ command, idleTimeoutMs: 60_000 });
  const provider = new GrokAcpProvider({ pool, timeoutMs: 5_000 });
  try {
    const result = await provider.runTurn({
      constructedPrompt: "first",
      cwd: dir,
      mode: "reviewer",
      structuredOutput: false,
    });
    assert.equal(result.isError, false);
    assert.ok((result.progress?.toolCallCount ?? 0) > 0);
    assert.equal(result.progress?.lastTool, "read_file");
  } finally {
    await pool.disposeAll();
  }
});

test("GrokAcpProvider default timeout uses grokTurnTimeoutMs", (t) => {
  const prevGrok = process.env.GROK_TURN_TIMEOUT_MS;
  const prevPeer = process.env.PEER_AGENTS_TURN_TIMEOUT_MS;
  t.after(() => {
    if (prevGrok === undefined) delete process.env.GROK_TURN_TIMEOUT_MS;
    else process.env.GROK_TURN_TIMEOUT_MS = prevGrok;
    if (prevPeer === undefined) delete process.env.PEER_AGENTS_TURN_TIMEOUT_MS;
    else process.env.PEER_AGENTS_TURN_TIMEOUT_MS = prevPeer;
  });
  delete process.env.GROK_TURN_TIMEOUT_MS;
  process.env.PEER_AGENTS_TURN_TIMEOUT_MS = "120000";
  assert.equal(grokTurnTimeoutMs(), DEFAULT_GROK_TURN_TIMEOUT_MS);
  const provider = new GrokAcpProvider({ timeoutMs: grokTurnTimeoutMs() });
  assert.equal(grokTurnTimeoutMs(), 360_000);
  void provider;
});

test("ACP prompt timeout sends session/cancel and drops liveSessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-acp-timeout-cancel-"));
  const cancelFile = join(dir, "cancel.txt");
  const command = await writeFakeAcp(dir, { promptDelayMs: 2000, cancelFile });
  const client = new GrokAcpClient({ command, idleTimeoutMs: 60_000 });
  try {
    const sid = await client.createSession(dir);
    const result = await client.prompt({
      sessionId: sid,
      text: "hello",
      timeoutMs: 200,
    });
    assert.equal(result.timedOut, true);
    assert.equal(client.liveSessions.has(sid), false);
    const deadline = Date.now() + 2000;
    let cancelLog = "";
    while (Date.now() < deadline) {
      cancelLog = await readFile(cancelFile, "utf8").catch(() => "");
      if (cancelLog.includes("CANCEL")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(cancelLog, /CANCEL/);
  } finally {
    await client.dispose();
  }
});
