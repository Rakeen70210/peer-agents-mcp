import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AntigravityHeadlessProvider } from "../src/providers/antigravity-headless.js";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("antigravity provider stages binaries and references them in prompt", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "peer-agents-agy-"));
  const captureFile = join(repoPath, "captured-args.txt");
  const scriptPath = join(repoPath, "capture.sh");
  await writeFile(
    scriptPath,
    `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg" >> "${captureFile}"; done\necho agy:ok\n`,
  );
  await chmod(scriptPath, 0o755);

  const provider = new AntigravityHeadlessProvider({
    command: scriptPath,
    timeoutMs: 5_000,
  });
  const result = await provider.runTurn({
    constructedPrompt: "Review the screenshot.",
    cwd: repoPath,
    mode: "reviewer",
    files: [
      {
        path: "ui/login.png",
        content: `data:image/png;base64,${PNG_BASE64}`,
      },
    ],
  });

  assert.equal(result.isError, false);
  const captured = await readFile(captureFile, "utf8");
  assert.match(captured, /Staged workspace attachments/);
  assert.match(captured, /\.peer-agents-staging-/);
  assert.match(captured, /login\.png/);
  assert.doesNotMatch(captured, /iVBORw0KGgo/);
  assert.match(captured, /Review the screenshot\./);
});