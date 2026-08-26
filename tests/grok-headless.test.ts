import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GrokHeadlessProvider,
  isLikelyResumeFailure,
  metricsFromGrokJson,
  projectGrokResult,
  sanitizeWorktreeName,
} from "../src/providers/grok-headless.js";
import { formatStructuredAsText } from "../src/providers/grok-schema.js";

async function makeCaptureCli(dir: string, response: object) {
  const captureFile = join(dir, "args.txt");
  const scriptPath = join(dir, "fake-grok.sh");
  const responseJson = JSON.stringify(response).replace(/'/g, `'\\''`);
  await writeFile(
    scriptPath,
    `#!/bin/sh
printf '%s\\n' "$@" > "${captureFile}"
# also dump prompt-file contents if present
prev=
for arg in "$@"; do
  if [ "$prev" = "--prompt-file" ]; then
    echo "PROMPT_FILE=$arg" >> "${captureFile}"
    if [ -f "$arg" ]; then
      echo "PROMPT_BODY_BEGIN" >> "${captureFile}"
      cat "$arg" >> "${captureFile}"
      echo "PROMPT_BODY_END" >> "${captureFile}"
    fi
  fi
  prev=$arg
done
printf '%s\\n' '${responseJson}'
`,
  );
  await chmod(scriptPath, 0o755);
  return { scriptPath, captureFile };
}

test("grok reviewer profile uses read-only sandbox and prompt-file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-grok-"));
  const { scriptPath, captureFile } = await makeCaptureCli(dir, {
    text: "looks fine",
    sessionId: "sess-1",
    stopReason: "EndTurn",
    num_turns: 3,
    usage: {
      input_tokens: 10,
      cache_read_input_tokens: 20,
      output_tokens: 5,
      total_tokens: 35,
    },
  });

  const provider = new GrokHeadlessProvider({
    command: scriptPath,
    promptDir: join(dir, "prompts"),
  });
  const result = await provider.runTurn({
    constructedPrompt: "Review this huge patch\n" + "x".repeat(100),
    mode: "reviewer",
    cwd: dir,
    structuredOutput: false,
  });

  assert.equal(result.isError, false);
  assert.equal(result.nativeSessionId, "sess-1");
  assert.equal(result.metrics?.numTurns, 3);
  assert.equal(result.metrics?.usage?.totalTokens, 35);

  const captured = await readFile(captureFile, "utf8");
  assert.match(captured, /--prompt-file/);
  assert.match(captured, /--sandbox\nread-only/);
  assert.match(captured, /--disallowed-tools\nsearch_replace,write/);
  assert.match(captured, /--disable-web-search/);
  assert.match(captured, /--always-approve/);
  assert.match(captured, /--no-plan/);
  assert.match(captured, /--no-subagents/);
  assert.match(captured, /--deny\nBash\(rm -rf \*\)/);
  assert.match(captured, /--deny\nBash\(git push \*\)/);
  assert.doesNotMatch(captured, /--permission-mode\ndefault/);
  assert.doesNotMatch(captured, /--check/);
  assert.match(captured, /PROMPT_BODY_BEGIN[\s\S]*Review this huge patch/);
});

test("grok implementer profile always-approves and can request worktree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-grok-impl-"));
  const { scriptPath, captureFile } = await makeCaptureCli(dir, {
    text: "implemented",
    sessionId: "sess-impl",
  });

  const provider = new GrokHeadlessProvider({
    command: scriptPath,
    promptDir: join(dir, "prompts"),
  });
  const result = await provider.runTurn({
    constructedPrompt: "Implement the feature",
    mode: "implementer",
    cwd: dir,
    worktree: "peer-impl-abc",
    structuredOutput: false,
  });

  assert.equal(result.isError, false);
  assert.equal(result.worktreeName, "peer-impl-abc");
  const captured = await readFile(captureFile, "utf8");
  assert.match(captured, /--always-approve/);
  assert.match(captured, /--sandbox\nworkspace/);
  // Grok 1.0 headless ignores --worktree; non-git cwd skips isolation.
  assert.doesNotMatch(captured, /--worktree/);
  assert.doesNotMatch(captured, /--resume/);
});

test("grok passes --resume and skips worktree on follow-up", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-grok-resume-"));
  const { scriptPath, captureFile } = await makeCaptureCli(dir, {
    text: "follow-up ok",
    sessionId: "sess-1",
  });

  const provider = new GrokHeadlessProvider({
    command: scriptPath,
    promptDir: join(dir, "prompts"),
  });
  const result = await provider.runTurn({
    constructedPrompt: "Continue please",
    mode: "implementer",
    nativeSessionId: "sess-1",
    worktree: "peer-impl-abc",
    structuredOutput: false,
  });

  assert.equal(result.resumed, true);
  assert.equal(result.isError, false);
  const captured = await readFile(captureFile, "utf8");
  assert.match(captured, /--resume\nsess-1/);
  assert.doesNotMatch(captured, /--worktree/);
});

test("grok structured output uses json-schema and pretty-prints findings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-grok-schema-"));
  const structured = {
    summary: "One issue found",
    findings: [
      {
        severity: "major",
        file: "src/a.ts",
        issue: "Null deref",
        suggestion: "Add guard",
      },
    ],
    residual_risks: ["Untested path"],
    recommended_next_steps: ["Add unit test"],
  };
  const { scriptPath, captureFile } = await makeCaptureCli(dir, {
    text: JSON.stringify(structured),
    sessionId: "sess-s",
  });

  const provider = new GrokHeadlessProvider({
    command: scriptPath,
    promptDir: join(dir, "prompts"),
  });
  const result = await provider.runTurn({
    constructedPrompt: "Review",
    mode: "reviewer",
    structuredOutput: true,
  });

  assert.equal(result.isError, false);
  assert.deepEqual(result.structured, structured);
  assert.match(result.text, /\[major\]/);
  assert.match(result.text, /Null deref/);
  const captured = await readFile(captureFile, "utf8");
  assert.match(captured, /--json-schema/);
});

test("high risk review enables effort and does not pass removed --check", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-grok-risk-"));
  const { scriptPath, captureFile } = await makeCaptureCli(dir, {
    text: "ok",
    sessionId: "s",
  });
  const provider = new GrokHeadlessProvider({
    command: scriptPath,
    promptDir: join(dir, "prompts"),
  });
  await provider.runTurn({
    constructedPrompt: "Security review",
    mode: "reviewer",
    riskLevel: "high",
    focus: "security",
    structuredOutput: false,
  });
  const captured = await readFile(captureFile, "utf8");
  assert.match(captured, /--effort\nhigh/);
  assert.doesNotMatch(captured, /--check/);
  assert.match(captured, /Self-verify/);
});

test("prompt files are cleaned up after the turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-grok-cleanup-"));
  const promptDir = join(dir, "prompts");
  const { scriptPath } = await makeCaptureCli(dir, {
    text: "ok",
    sessionId: "s",
  });
  const provider = new GrokHeadlessProvider({
    command: scriptPath,
    promptDir,
  });
  await provider.runTurn({
    constructedPrompt: "hello",
    mode: "planner",
    structuredOutput: false,
  });
  const remaining = await readdir(promptDir).catch(() => [] as string[]);
  assert.equal(remaining.length, 0);
});

test("metricsFromGrokJson maps spend fields", () => {
  const metrics = metricsFromGrokJson({
    stopReason: "EndTurn",
    num_turns: 2,
    usage: {
      input_tokens: 1,
      cache_read_input_tokens: 2,
      output_tokens: 3,
      total_tokens: 6,
    },
    total_cost_usd: 0.01,
  });
  assert.equal(metrics?.stopReason, "EndTurn");
  assert.equal(metrics?.usage?.cacheReadInputTokens, 2);
  assert.equal(metrics?.totalCostUsd, 0.01);
});

test("isLikelyResumeFailure detects session errors", () => {
  assert.equal(
    isLikelyResumeFailure({
      isError: true,
      text: "",
      stdout: "",
      stderr: "Couldn't start session: not found",
    }),
    true,
  );
  assert.equal(
    isLikelyResumeFailure({
      isError: true,
      text: "",
      stdout: "",
      stderr: "unknown conversation id",
    }),
    true,
  );
  assert.equal(
    isLikelyResumeFailure({
      isError: true,
      text: "logic bug in code",
      stdout: "",
      stderr: "",
    }),
    false,
  );
});

test("sanitizeWorktreeName strips unsafe chars", () => {
  assert.equal(sanitizeWorktreeName("peer impl/../x"), "peer-impl-..-x");
});

test("formatStructuredAsText renders findings", () => {
  const text = formatStructuredAsText({
    summary: "Summary",
    findings: [{ severity: "blocker", issue: "Auth bypass", file: "a.ts" }],
    residual_risks: [],
    recommended_next_steps: ["Fix now"],
  });
  assert.match(text, /Summary/);
  assert.match(text, /\[blocker\] \(a\.ts\) Auth bypass/);
});

test("projectGrokResult handles error objects", () => {
  const result = projectGrokResult({
    stdout: JSON.stringify({ type: "error", message: "auth failed" }),
    stderr: "",
    exitCode: 1,
    expectStructured: false,
  });
  assert.equal(result.isError, true);
  assert.match(result.text, /auth failed/);
});

test("grok planner uses permission-mode plan without no-plan", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-grok-plan-"));
  const { scriptPath, captureFile } = await makeCaptureCli(dir, {
    text: "plan ok",
    sessionId: "s",
  });
  const provider = new GrokHeadlessProvider({
    command: scriptPath,
    promptDir: join(dir, "prompts"),
  });
  await provider.runTurn({
    constructedPrompt: "Plan the migration",
    mode: "planner",
    structuredOutput: false,
  });
  const captured = await readFile(captureFile, "utf8");
  assert.match(captured, /--permission-mode\nplan/);
  assert.match(captured, /--always-approve/);
  assert.match(captured, /--sandbox\nread-only/);
  assert.match(captured, /--disallowed-tools\nsearch_replace,write/);
  assert.match(captured, /--deny\nBash\(rm -rf \*\)/);
  assert.match(captured, /--deny\nBash\(git push \*\)/);
  assert.doesNotMatch(captured, /--no-plan/);
  assert.doesNotMatch(captured, /--no-subagents/);
  assert.doesNotMatch(captured, /--permission-mode\ndefault/);
});

test("git worktree isolation points --cwd at a real worktree", async () => {
  const repo = await mkdtemp(join(tmpdir(), "peer-grok-wt-repo-"));
  const worktreeRoot = join(repo, "peer-worktrees");
  execFileSync("git", ["init"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "peer@test"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Peer Test"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "hi\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo });

  const { scriptPath, captureFile } = await makeCaptureCli(repo, {
    text: "implemented",
    sessionId: "sess-wt",
  });
  const provider = new GrokHeadlessProvider({
    command: scriptPath,
    promptDir: join(repo, "prompts"),
    worktreeRoot,
  });
  const result = await provider.runTurn({
    constructedPrompt: "Implement in isolation",
    mode: "implementer",
    cwd: repo,
    worktree: "peer-impl-wt",
    structuredOutput: false,
  });

  assert.equal(result.isError, false);
  assert.equal(result.worktreeName, "peer-impl-wt");
  const captured = await readFile(captureFile, "utf8");
  assert.doesNotMatch(captured, /--worktree/);
  assert.match(captured, /--cwd\n.*peer-impl-wt/);
  const listed = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.match(listed, /peer-impl-wt/);
});
