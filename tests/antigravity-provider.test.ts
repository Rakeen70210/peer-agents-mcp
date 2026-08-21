import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  findNewConversationId,
  listConversationIds,
} from "../src/providers/antigravity-conversations.js";
import {
  AntigravityHeadlessProvider,
  createAgyStreamAccumulator,
} from "../src/providers/antigravity-headless.js";
import { capabilityProfileForMode } from "../src/providers/antigravity-profiles.js";

function envelopeJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    conversation_id: "from-json",
    status: "SUCCESS",
    response: "agy:ok",
    num_turns: 1,
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      thinking_tokens: 2,
      cache_read_tokens: 3,
      total_tokens: 14,
    },
    ...overrides,
  });
}

async function writeCaptureScript(
  dir: string,
  captureFile: string,
  envelope: Record<string, unknown> = {},
) {
  const scriptPath = join(dir, "capture.sh");
  const json = envelopeJson(envelope).replace(/'/g, `'\\''`);
  await writeFile(
    scriptPath,
    `#!/bin/sh
printf '%s\\n' "$@" > "${captureFile}"
printf '%s\\n' '${json}'
`,
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

test("capability profiles map modes to sandbox/mode flags", () => {
  assert.deepEqual(capabilityProfileForMode("reviewer").args, ["--sandbox"]);
  assert.deepEqual(capabilityProfileForMode("critic").args, ["--sandbox"]);
  assert.deepEqual(capabilityProfileForMode("planner").args, [
    "--sandbox",
    "--mode",
    "plan",
  ]);
  assert.deepEqual(capabilityProfileForMode("implementer").args, [
    "--mode",
    "accept-edits",
  ]);
});

test("listConversationIds ignores wal/shm and reports db basenames", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-agy-conv-"));
  await writeFile(join(dir, "aaa-111.db"), "");
  await writeFile(join(dir, "aaa-111.db-wal"), "");
  await writeFile(join(dir, "aaa-111.db-shm"), "");
  await writeFile(join(dir, "bbb-222.db"), "");
  const ids = await listConversationIds(dir);
  assert.deepEqual([...ids].sort(), ["aaa-111", "bbb-222"]);
});

test("findNewConversationId returns sole new id or undefined if ambiguous", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-agy-new-"));
  await writeFile(join(dir, "old.db"), "");
  const before = await listConversationIds(dir);

  await writeFile(join(dir, "new-one.db"), "");
  assert.equal(await findNewConversationId(before, dir), "new-one");

  await writeFile(join(dir, "new-two.db"), "");
  assert.equal(await findNewConversationId(before, dir), undefined);
});

test("reviewer turn uses json envelope, schema, and slash-disable", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "peer-agy-rev-"));
  const convDir = join(repoPath, "conversations");
  await mkdir(convDir, { recursive: true });
  const captureFile = join(repoPath, "args.txt");
  const scriptPath = await writeCaptureScript(repoPath, captureFile);

  const provider = new AntigravityHeadlessProvider({
    command: scriptPath,
    timeoutMs: 5_000,
    conversationsDir: convDir,
  });
  const result = await provider.runTurn({
    constructedPrompt: "Review this",
    cwd: repoPath,
    mode: "reviewer",
  });

  assert.equal(result.isError, false);
  assert.equal(result.text, "agy:ok");
  assert.equal(result.nativeSessionId, "from-json");
  assert.equal(result.resumed, false);
  assert.equal(result.metrics?.numTurns, 1);
  assert.equal(result.metrics?.usage?.inputTokens, 10);
  assert.equal(result.metrics?.usage?.reasoningTokens, 2);
  assert.equal(result.metrics?.usage?.cacheReadInputTokens, 3);

  const captured = await readFile(captureFile, "utf8");
  assert.match(captured, /--sandbox/);
  assert.match(captured, /--dangerously-skip-permissions/);
  assert.match(captured, /--print-timeout/);
  assert.match(captured, /--output-format\njson/);
  assert.match(captured, /--disable-slash-commands/);
  assert.match(captured, /--json-schema/);
  assert.doesNotMatch(captured, /--conversation/);
  assert.doesNotMatch(captured, /--mode/);
});

test("resume turn passes --conversation and skips capture", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "peer-agy-resume-"));
  const convDir = join(repoPath, "conversations");
  await mkdir(convDir, { recursive: true });
  const captureFile = join(repoPath, "args.txt");
  const scriptPath = await writeCaptureScript(repoPath, captureFile);

  // Even if a new db appears, resumed turns keep the provided id.
  await writeFile(
    scriptPath,
    `#!/bin/sh
printf '%s\\n' "$@" > "${captureFile}"
touch "${convDir}/should-ignore.db"
printf '%s\\n' '{"conversation_id":"existing-conv","status":"SUCCESS","response":"resumed-ok"}'
`,
  );
  await chmod(scriptPath, 0o755);

  const provider = new AntigravityHeadlessProvider({
    command: scriptPath,
    timeoutMs: 5_000,
    conversationsDir: convDir,
  });
  const result = await provider.runTurn({
    constructedPrompt: "Continue",
    cwd: repoPath,
    mode: "reviewer",
    nativeSessionId: "existing-conv",
  });

  assert.equal(result.isError, false);
  assert.equal(result.nativeSessionId, "existing-conv");
  assert.equal(result.resumed, true);

  const captured = await readFile(captureFile, "utf8");
  assert.match(captured, /--conversation\nexisting-conv/);
});

test("planner uses sandbox + plan mode; implementer uses accept-edits", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "peer-agy-modes-"));
  const convDir = join(repoPath, "conversations");
  await mkdir(convDir, { recursive: true });
  const captureFile = join(repoPath, "args.txt");
  const scriptPath = await writeCaptureScript(repoPath, captureFile);

  const provider = new AntigravityHeadlessProvider({
    command: scriptPath,
    timeoutMs: 5_000,
    conversationsDir: convDir,
  });

  await provider.runTurn({
    constructedPrompt: "plan",
    mode: "planner",
  });
  let captured = await readFile(captureFile, "utf8");
  assert.match(captured, /--sandbox/);
  assert.match(captured, /--mode\nplan/);

  await provider.runTurn({
    constructedPrompt: "implement",
    mode: "implementer",
    agent: "my-agent",
  });
  captured = await readFile(captureFile, "utf8");
  assert.match(captured, /--mode\naccept-edits/);
  assert.match(captured, /--agent\nmy-agent/);
  assert.doesNotMatch(captured, /--sandbox/);
});

test("ambiguous new conversations leave nativeSessionId unset", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "peer-agy-ambig-"));
  const convDir = join(repoPath, "conversations");
  await mkdir(convDir, { recursive: true });
  const scriptPath = join(repoPath, "capture.sh");
  await writeFile(
    scriptPath,
    `#!/bin/sh
touch "${convDir}/one.db"
touch "${convDir}/two.db"
printf '%s\\n' '{"status":"SUCCESS","response":"ok","conversation_id":""}'
`,
  );
  await chmod(scriptPath, 0o755);

  const provider = new AntigravityHeadlessProvider({
    command: scriptPath,
    timeoutMs: 5_000,
    conversationsDir: convDir,
  });
  const result = await provider.runTurn({
    constructedPrompt: "hi",
    mode: "reviewer",
  });
  assert.equal(result.isError, false);
  assert.equal(result.nativeSessionId, undefined);
});

test("json envelope conversation_id wins over dir snapshot", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "peer-agy-jsonwin-"));
  const convDir = join(repoPath, "conversations");
  await mkdir(convDir, { recursive: true });
  const captureFile = join(repoPath, "args.txt");
  const scriptPath = join(repoPath, "capture.sh");
  await writeFile(
    scriptPath,
    `#!/bin/sh
printf '%s\\n' "$@" > "${captureFile}"
touch "${convDir}/from-db.db"
printf '%s\\n' '{"conversation_id":"from-envelope","status":"SUCCESS","response":"ok"}'
`,
  );
  await chmod(scriptPath, 0o755);

  const provider = new AntigravityHeadlessProvider({
    command: scriptPath,
    timeoutMs: 5_000,
    conversationsDir: convDir,
  });
  const result = await provider.runTurn({
    constructedPrompt: "hi",
    mode: "reviewer",
  });
  assert.equal(result.nativeSessionId, "from-envelope");
});

test("dir snapshot is fallback when envelope has no conversation_id", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "peer-agy-fallback-"));
  const convDir = join(repoPath, "conversations");
  await mkdir(convDir, { recursive: true });
  const scriptPath = join(repoPath, "capture.sh");
  await writeFile(
    scriptPath,
    `#!/bin/sh
touch "${convDir}/captured-uuid.db"
printf '%s\\n' '{"status":"SUCCESS","response":"ok"}'
`,
  );
  await chmod(scriptPath, 0o755);

  const provider = new AntigravityHeadlessProvider({
    command: scriptPath,
    timeoutMs: 5_000,
    conversationsDir: convDir,
  });
  const result = await provider.runTurn({
    constructedPrompt: "hi",
    mode: "reviewer",
  });
  assert.equal(result.nativeSessionId, "captured-uuid");
});

test("high risk maps to --effort high; implementer skips json-schema", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "peer-agy-effort-"));
  const convDir = join(repoPath, "conversations");
  await mkdir(convDir, { recursive: true });
  const captureFile = join(repoPath, "args.txt");
  const scriptPath = await writeCaptureScript(repoPath, captureFile);

  const provider = new AntigravityHeadlessProvider({
    command: scriptPath,
    timeoutMs: 5_000,
    conversationsDir: convDir,
  });

  await provider.runTurn({
    constructedPrompt: "review risky",
    mode: "reviewer",
    riskLevel: "high",
  });
  let captured = await readFile(captureFile, "utf8");
  assert.match(captured, /--effort\nhigh/);

  await provider.runTurn({
    constructedPrompt: "implement",
    mode: "implementer",
    structuredOutput: false,
  });
  captured = await readFile(captureFile, "utf8");
  assert.doesNotMatch(captured, /--json-schema/);
});

test("structured_output is parsed from json envelope", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "peer-agy-struct-"));
  const convDir = join(repoPath, "conversations");
  await mkdir(convDir, { recursive: true });
  const captureFile = join(repoPath, "args.txt");
  const structured = {
    summary: "One issue",
    findings: [{ severity: "major", issue: "Null deref", file: "a.ts" }],
    residual_risks: [],
    recommended_next_steps: ["Add guard"],
  };
  const scriptPath = await writeCaptureScript(repoPath, captureFile, {
    response: JSON.stringify(structured),
    structured_output: structured,
  });

  const provider = new AntigravityHeadlessProvider({
    command: scriptPath,
    timeoutMs: 5_000,
    conversationsDir: convDir,
  });
  const result = await provider.runTurn({
    constructedPrompt: "Review",
    mode: "reviewer",
    structuredOutput: true,
  });
  assert.equal(result.isError, false);
  assert.deepEqual(result.structured, structured);
  assert.match(result.text, /\[major\]/);
});

test("CANCELED envelope is treated as cancelled", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "peer-agy-cancel-"));
  const convDir = join(repoPath, "conversations");
  await mkdir(convDir, { recursive: true });
  const scriptPath = await writeCaptureScript(repoPath, join(repoPath, "args.txt"), {
    status: "CANCELED",
    response: "",
    conversation_id: "c1",
  });

  const provider = new AntigravityHeadlessProvider({
    command: scriptPath,
    timeoutMs: 5_000,
    conversationsDir: convDir,
  });
  const result = await provider.runTurn({
    constructedPrompt: "hi",
    mode: "reviewer",
  });
  assert.equal(result.isError, true);
  assert.equal(result.cancelled, true);
  assert.equal(result.nativeSessionId, "c1");
});

test("agy stream accumulator builds text and progress from NDJSON events", () => {
  const updates: number[] = [];
  const acc = createAgyStreamAccumulator((p) => {
    updates.push(p.eventCount);
  });
  acc.onLine(
    JSON.stringify({
      event: "init",
      conversation_id: "s1",
      init: { cwd: "/tmp" },
    }),
  );
  acc.onLine(
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "s1",
        step_index: 1,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
      },
    }),
  );
  acc.onLine(
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "s1",
        step_index: 2,
        state: "ACTIVE",
        step_type: "agent_response",
        text_delta: "Hello ",
      },
    }),
  );
  acc.onLine(
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "s1",
        step_index: 2,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "world",
      },
    }),
  );
  acc.onLine(
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "s1",
        status: "SUCCESS",
        response: "Hello world",
        num_turns: 3,
      },
    }),
  );

  assert.equal(acc.text(), "Hello world");
  assert.equal(acc.conversationId(), "s1");
  assert.equal(acc.resultEvent()?.num_turns, 3);
  assert.equal(acc.progress().numTurns, 3);
  assert.match(acc.progress().lastThought ?? "", /run_command/);
  assert.ok(updates.length >= 3);
});

test("streamProgress uses stream-json and reports progress from NDJSON", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "peer-agy-stream-"));
  const convDir = join(repoPath, "conversations");
  await mkdir(convDir, { recursive: true });
  const captureFile = join(repoPath, "args.txt");
  const scriptPath = join(repoPath, "capture.sh");
  await writeFile(
    scriptPath,
    `#!/bin/sh
printf '%s\\n' "$@" > "${captureFile}"
printf '%s\\n' '{"event":"init","conversation_id":"stream-1","init":{"cwd":"/tmp"}}'
printf '%s\\n' '{"event":"step_update","step_update":{"conversation_id":"stream-1","step_index":0,"state":"DONE","step_type":"user_input"}}'
printf '%s\\n' '{"event":"step_update","step_update":{"conversation_id":"stream-1","step_index":1,"state":"ACTIVE","step_type":"tool","tool_name":"run_command"}}'
printf '%s\\n' '{"event":"step_update","step_update":{"conversation_id":"stream-1","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"partial "}}'
printf '%s\\n' '{"event":"step_update","step_update":{"conversation_id":"stream-1","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"answer"}}'
printf '%s\\n' '{"event":"result","result":{"conversation_id":"stream-1","status":"SUCCESS","response":"partial answer","num_turns":2,"usage":{"input_tokens":10,"output_tokens":4,"thinking_tokens":2,"cache_read_tokens":3,"total_tokens":14}}}'
`,
  );
  await chmod(scriptPath, 0o755);

  const progressEvents: Array<{ text?: string; thought?: string }> = [];
  const provider = new AntigravityHeadlessProvider({
    command: scriptPath,
    timeoutMs: 5_000,
    conversationsDir: convDir,
  });
  const result = await provider.runTurn({
    constructedPrompt: "stream me",
    cwd: repoPath,
    mode: "implementer",
    structuredOutput: false,
    streamProgress: true,
    onProgress: (p) => {
      progressEvents.push({
        text: p.textSnippet,
        thought: p.lastThought,
      });
    },
  });

  assert.equal(result.isError, false);
  assert.equal(result.text, "partial answer");
  assert.equal(result.nativeSessionId, "stream-1");
  assert.equal(result.metrics?.numTurns, 2);
  assert.equal(result.metrics?.usage?.reasoningTokens, 2);
  assert.ok(progressEvents.some((p) => p.text?.includes("partial")));
  assert.ok(progressEvents.some((p) => p.thought?.includes("run_command")));
  assert.ok((result.progress?.eventCount ?? 0) >= 3);

  const captured = await readFile(captureFile, "utf8");
  assert.match(captured, /--output-format\nstream-json/);
  assert.doesNotMatch(captured, /--output-format\njson/);
  assert.match(captured, /--disable-slash-commands/);
});

test("stream-json result CANCELED is treated as cancelled", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "peer-agy-stream-cancel-"));
  const convDir = join(repoPath, "conversations");
  await mkdir(convDir, { recursive: true });
  const scriptPath = join(repoPath, "capture.sh");
  await writeFile(
    scriptPath,
    `#!/bin/sh
printf '%s\\n' '{"event":"init","conversation_id":"c1","init":{}}'
printf '%s\\n' '{"event":"result","result":{"conversation_id":"c1","status":"CANCELED","response":"","error":"denied"}}'
`,
  );
  await chmod(scriptPath, 0o755);

  const provider = new AntigravityHeadlessProvider({
    command: scriptPath,
    timeoutMs: 5_000,
    conversationsDir: convDir,
  });
  const result = await provider.runTurn({
    constructedPrompt: "hi",
    mode: "reviewer",
    streamProgress: true,
  });
  assert.equal(result.isError, true);
  assert.equal(result.cancelled, true);
  assert.equal(result.nativeSessionId, "c1");
});

test("stream-json result structured_output is parsed", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "peer-agy-stream-struct-"));
  const convDir = join(repoPath, "conversations");
  await mkdir(convDir, { recursive: true });
  const structured = {
    summary: "One issue",
    findings: [{ severity: "major", issue: "Null deref", file: "a.ts" }],
    residual_risks: [],
    recommended_next_steps: ["Add guard"],
  };
  const scriptPath = join(repoPath, "capture.sh");
  const resultJson = JSON.stringify({
    event: "result",
    result: {
      conversation_id: "s1",
      status: "SUCCESS",
      response: JSON.stringify(structured),
      structured_output: structured,
      num_turns: 1,
    },
  }).replace(/'/g, `'\\''`);
  await writeFile(
    scriptPath,
    `#!/bin/sh
printf '%s\\n' '{"event":"init","conversation_id":"s1","init":{}}'
printf '%s\\n' '${resultJson}'
`,
  );
  await chmod(scriptPath, 0o755);

  const provider = new AntigravityHeadlessProvider({
    command: scriptPath,
    timeoutMs: 5_000,
    conversationsDir: convDir,
  });
  const result = await provider.runTurn({
    constructedPrompt: "Review",
    mode: "reviewer",
    structuredOutput: true,
    streamProgress: true,
  });
  assert.equal(result.isError, false);
  assert.deepEqual(result.structured, structured);
  assert.match(result.text, /\[major\]/);
});

test("ANTIGRAVITY_ARGS cannot double managed json flags", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "peer-agy-strip-"));
  const convDir = join(repoPath, "conversations");
  await mkdir(convDir, { recursive: true });
  const captureFile = join(repoPath, "args.txt");
  const scriptPath = await writeCaptureScript(repoPath, captureFile);

  const provider = new AntigravityHeadlessProvider({
    command: scriptPath,
    timeoutMs: 5_000,
    conversationsDir: convDir,
    baseArgs: [
      "--output-format",
      "text",
      "--json-schema",
      "{}",
      "--effort",
      "low",
      "--disable-slash-commands",
    ],
  });
  await provider.runTurn({
    constructedPrompt: "hi",
    mode: "planner",
    structuredOutput: false,
  });
  const captured = await readFile(captureFile, "utf8");
  assert.equal([...captured.matchAll(/--output-format/g)].length, 1);
  assert.match(captured, /--output-format\njson/);
  assert.doesNotMatch(captured, /--output-format\ntext/);
  assert.doesNotMatch(captured, /--effort\nlow/);
});
