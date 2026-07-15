import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  findNewConversationId,
  listConversationIds,
} from "../src/providers/antigravity-conversations.js";
import { AntigravityHeadlessProvider } from "../src/providers/antigravity-headless.js";
import { capabilityProfileForMode } from "../src/providers/antigravity-profiles.js";

async function writeCaptureScript(dir: string, captureFile: string) {
  const scriptPath = join(dir, "capture.sh");
  await writeFile(
    scriptPath,
    `#!/bin/sh
printf '%s\\n' "$@" > "${captureFile}"
echo agy:ok
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

test("reviewer turn passes --sandbox and captures new conversation id", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "peer-agy-rev-"));
  const convDir = join(repoPath, "conversations");
  await mkdir(convDir, { recursive: true });
  const captureFile = join(repoPath, "args.txt");
  const scriptPath = await writeCaptureScript(repoPath, captureFile);

  // Script also creates a conversation db so capture can succeed.
  await writeFile(
    scriptPath,
    `#!/bin/sh
printf '%s\\n' "$@" > "${captureFile}"
touch "${convDir}/captured-uuid.db"
echo agy:ok
`,
  );
  await chmod(scriptPath, 0o755);

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
  assert.equal(result.nativeSessionId, "captured-uuid");
  assert.equal(result.resumed, false);

  const captured = await readFile(captureFile, "utf8");
  assert.match(captured, /--sandbox/);
  assert.match(captured, /--dangerously-skip-permissions/);
  assert.match(captured, /--print-timeout/);
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
echo resumed-ok
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
echo ok
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
