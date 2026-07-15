import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AntigravityHeadlessProvider } from "../src/providers/antigravity-headless.js";
import { runCommand } from "../src/providers/runner.js";

test("runCommand aborts via signal and preserves captured output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-runner-"));
  const script = join(dir, "slow.sh");
  await writeFile(
    script,
    `#!/bin/sh
echo partial-out
echo partial-err >&2
sleep 30
echo never
`,
  );
  await chmod(script, 0o755);

  const controller = new AbortController();
  const started = Date.now();
  const running = runCommand({
    command: script,
    args: [],
    timeoutMs: 60_000,
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();
  const result = await running;
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 5_000, `abort should be quick, took ${elapsed}ms`);
  assert.equal(result.aborted, true);
  assert.match(result.stdout, /partial-out/);
  assert.match(result.stderr, /partial-err/);
});

test("runCommand times out and preserves output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-runner-"));
  const script = join(dir, "slow.sh");
  await writeFile(
    script,
    `#!/bin/sh
echo before-timeout
sleep 30
`,
  );
  await chmod(script, 0o755);

  const result = await runCommand({
    command: script,
    args: [],
    timeoutMs: 150,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
  assert.match(result.stdout, /before-timeout/);
});

test("antigravity still cleans up staged attachments on abort", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "peer-agy-abort-"));
  const scriptPath = join(repoPath, "slow-agy.sh");
  await writeFile(
    scriptPath,
    `#!/bin/sh
# consume args
for _ in "$@"; do :; done
sleep 30
echo never
`,
  );
  await chmod(scriptPath, 0o755);

  const provider = new AntigravityHeadlessProvider({
    command: scriptPath,
    timeoutMs: 60_000,
  });
  const controller = new AbortController();
  const turn = provider.runTurn({
    constructedPrompt: "Review screenshot",
    cwd: repoPath,
    mode: "reviewer",
    files: [
      {
        path: "ui/x.png",
        content:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      },
    ],
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  controller.abort();
  const result = await turn;
  assert.equal(result.cancelled, true);
  assert.equal(result.isError, true);
});

test("antigravity passes per-call job timeout to --print-timeout", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "peer-agy-timeout-"));
  const captureFile = join(repoPath, "args.txt");
  const scriptPath = join(repoPath, "capture.sh");
  await writeFile(
    scriptPath,
    `#!/bin/sh
printf '%s\\n' "$@" > "${captureFile}"
echo ok
`,
  );
  await chmod(scriptPath, 0o755);

  const provider = new AntigravityHeadlessProvider({
    command: scriptPath,
    timeoutMs: 5_000,
  });
  await provider.runTurn({
    constructedPrompt: "hi",
    cwd: repoPath,
    mode: "reviewer",
    timeoutMs: 1_800_000,
  });
  const { readFile } = await import("node:fs/promises");
  const captured = await readFile(captureFile, "utf8");
  assert.match(captured, /--print-timeout/);
  assert.match(captured, /30m/);
});
