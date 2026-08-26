import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { jobTimeoutMsFor } from "../src/app.js";
import {
  GrokHeadlessProvider,
  isLikelyResumeFailure,
  metricsFromGrokJson,
  projectGrokResult,
  sanitizeWorktreeName,
} from "../src/providers/grok-headless.js";
import { formatStructuredAsText } from "../src/providers/grok-schema.js";
import { runCommand } from "../src/providers/runner.js";
import {
  DEFAULT_GROK_TURN_TIMEOUT_MS,
  grokAcpIdleTimeoutMs,
  grokTurnTimeoutMs,
  HEALTH_TURN_TIMEOUT_MS,
} from "../src/providers/grok-timeout.js";

function isolateEnv(
  t: { after: (fn: () => void) => void },
  updates: Record<string, string | undefined>,
): void {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(updates)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function mintedSessionId(captured: string): string | undefined {
  const fromFlag = captured.match(/--session-id\n([^\n]+)/);
  if (fromFlag?.[1]) return fromFlag[1];
  const fromEcho = captured.match(/^SESSION_ID=(.+)$/m);
  return fromEcho?.[1];
}

async function makeCaptureCli(dir: string, response: object) {
  const captureFile = join(dir, "args.txt");
  const scriptPath = join(dir, "fake-grok.sh");
  const responsePath = join(dir, "response.json");
  await writeFile(responsePath, `${JSON.stringify(response)}\n`);
  await writeFile(
    scriptPath,
    `#!/bin/sh
printf '%s\\n' "$@" > "${captureFile}"
# also dump prompt-file contents if present
session_id=
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
  if [ "$prev" = "--session-id" ]; then
    session_id="$arg"
    echo "SESSION_ID=$arg" >> "${captureFile}"
  fi
  if [ "$arg" = "--session-id" ]; then echo HAD_SESSION_ID >> "${captureFile}"; fi
  if [ "$arg" = "--resume" ]; then echo HAD_RESUME >> "${captureFile}"; fi
  prev=$arg
done
RESPONSE_FILE="${responsePath}" SESSION_ID="$session_id" node -e '
const fs = require("fs");
const r = JSON.parse(fs.readFileSync(process.env.RESPONSE_FILE, "utf8"));
if (process.env.SESSION_ID) r.sessionId = process.env.SESSION_ID;
process.stdout.write(JSON.stringify(r) + "\\n");
'
`,
  );
  await chmod(scriptPath, 0o755);
  return { scriptPath, captureFile };
}

async function makeStreamingCli(
  dir: string,
  events: object[],
  options?: { sleepMs?: number },
) {
  const captureFile = join(dir, "args.txt");
  const scriptPath = join(dir, "fake-grok.sh");
  const eventsPath = join(dir, "events.ndjson");
  await writeFile(
    eventsPath,
    events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""),
  );
  const sleep = options?.sleepMs ? `sleep ${Math.max(1, options.sleepMs / 1000)}\n` : "";
  await writeFile(
    scriptPath,
    `#!/bin/sh
printf '%s\\n' "$@" > "${captureFile}"
prev=
for arg in "$@"; do
  if [ "$prev" = "--session-id" ]; then echo "SESSION_ID=$arg" >> "${captureFile}"; fi
  if [ "$arg" = "--session-id" ]; then echo HAD_SESSION_ID >> "${captureFile}"; fi
  if [ "$arg" = "--resume" ]; then echo HAD_RESUME >> "${captureFile}"; fi
  prev=$arg
done
if [ -s "${eventsPath}" ]; then
  node -e 'const fs=require("fs"); process.stdout.write(fs.readFileSync(process.argv[1],"utf8"));' "${eventsPath}"
fi
${sleep}`,
  );
  await chmod(scriptPath, 0o755);
  return { scriptPath, captureFile };
}

async function makeSequentialCli(
  dir: string,
  payloads: object[],
  options?: { delayMs?: number },
) {
  const captureFile = join(dir, "args.txt");
  const countFile = join(dir, "count.txt");
  const scriptPath = join(dir, "fake-grok.sh");
  for (let index = 0; index < payloads.length; index += 1) {
    await writeFile(
      join(dir, `resp-${index + 1}.json`),
      `${JSON.stringify(payloads[index])}\n`,
    );
  }
  const delay = options?.delayMs
    ? `if [ "$count" -eq 1 ]; then sleep ${options.delayMs / 1000}; fi\n`
    : "";
  await writeFile(
    scriptPath,
    `#!/bin/sh
count=0
if [ -f "${countFile}" ]; then count=$(cat "${countFile}"); fi
count=$((count + 1))
printf '%s' "$count" > "${countFile}"
printf 'INVOCATION=%s\\n' "$count" >> "${captureFile}"
printf '%s\\n' "$@" >> "${captureFile}"
prev=
for arg in "$@"; do
  if [ "$prev" = "--resume" ]; then echo "RESUME_ID=$arg" >> "${captureFile}"; fi
  if [ "$prev" = "--session-id" ]; then echo "SESSION_ID=$arg" >> "${captureFile}"; fi
  if [ "$arg" = "--session-id" ]; then echo "HAD_SESSION_ID=$count" >> "${captureFile}"; fi
  if [ "$arg" = "--json-schema" ]; then echo HAD_JSON_SCHEMA >> "${captureFile}"; fi
  if [ "$prev" = "--prompt-file" ] && [ -f "$arg" ]; then
    echo PROMPT_BODY_BEGIN >> "${captureFile}"
    cat "$arg" >> "${captureFile}"
    echo PROMPT_BODY_END >> "${captureFile}"
  fi
  prev=$arg
done
${delay}resp="${dir}/resp-$count.json"
if [ ! -f "$resp" ]; then resp="${dir}/resp-${payloads.length}.json"; fi
cat "$resp"
`,
  );
  await chmod(scriptPath, 0o755);
  return { scriptPath, captureFile, countFile };
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
  const captured = await readFile(captureFile, "utf8");
  assert.equal(result.nativeSessionId, mintedSessionId(captured));
  assert.equal(result.metrics?.numTurns, 3);
  assert.equal(result.metrics?.usage?.totalTokens, 35);
  assert.match(captured, /--output-format\nstreaming-json/);
  assert.match(captured, /--session-id\n/);
  assert.doesNotMatch(captured, /--resume/);
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
  assert.doesNotMatch(captured, /--json-schema/);
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
  assert.match(captured, /Use tools \(read_file, grep, list_dir\)/);
  assert.doesNotMatch(captured, /prefer a single JSON object/);
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
  assert.equal(result.nativeSessionId, "sess-1");
  const captured = await readFile(captureFile, "utf8");
  assert.match(captured, /--resume\nsess-1/);
  assert.doesNotMatch(captured, /--session-id/);
  assert.doesNotMatch(captured, /--worktree/);
});

test("grok reviewer parses findings JSON without passing --json-schema", async () => {
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
  assert.equal(result.incompleteReview, undefined);
  assert.deepEqual(result.structured, structured);
  assert.match(result.text, /\[major\]/);
  assert.match(result.text, /Null deref/);
  const captured = await readFile(captureFile, "utf8");
  assert.doesNotMatch(captured, /--json-schema/);
  assert.match(captured, /Use tools \(read_file, grep, list_dir\)/);
  assert.match(captured, /prefer a single JSON object/);
});

test("complete prose without JSON is success with structured undefined", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-grok-prose-"));
  const { scriptPath, captureFile } = await makeCaptureCli(dir, {
    text: "No material issues; the change is limited to X in `src/foo.ts`.",
    sessionId: "sess-p",
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
  assert.equal(result.incompleteReview, undefined);
  assert.equal(result.structured, undefined);
  assert.match(result.text, /No material issues/);
  const captured = await readFile(captureFile, "utf8");
  assert.doesNotMatch(captured, /--json-schema/);
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
  assert.equal(
    isLikelyResumeFailure({
      isError: true,
      text: "",
      stdout: "",
      stderr: "spawn grok ENOENT",
    }),
    true,
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
  assert.match(captured, /Use tools \(read_file, grep, list_dir\)/);
  assert.doesNotMatch(captured, /prefer a single JSON object/);
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

const STUB_FINDINGS = {
  summary: "I'll inspect the full prompt, remediation plan, and current source/release contracts first…",
  findings: [] as unknown[],
  residual_risks: [] as unknown[],
  recommended_next_steps: [] as unknown[],
};

const REAL_FINDINGS = {
  summary: "One issue found",
  findings: [
    {
      severity: "major",
      file: "src/a.ts",
      issue: "Null deref",
      suggestion: "Add guard",
    },
  ],
  residual_risks: [] as unknown[],
  recommended_next_steps: ["Add a unit test"],
};

test("projectGrokResult marks live stub JSON as incomplete", () => {
  const result = projectGrokResult({
    stdout: JSON.stringify({
      text: JSON.stringify(STUB_FINDINGS),
      sessionId: "sess-stub",
      num_turns: 1,
    }),
    stderr: "",
    exitCode: 0,
    expectStructured: true,
  });
  assert.equal(result.isError, true);
  assert.equal(result.incompleteReview, true);
  assert.equal(result.nativeSessionId, "sess-stub");
});

test("projectGrokResult parses concatenated stub+real as the last object", () => {
  const result = projectGrokResult({
    stdout: JSON.stringify({
      text: JSON.stringify(STUB_FINDINGS) + JSON.stringify(REAL_FINDINGS),
      sessionId: "sess-concat",
    }),
    stderr: "",
    exitCode: 0,
    expectStructured: true,
  });
  assert.equal(result.isError, false);
  assert.equal(result.incompleteReview, undefined);
  assert.deepEqual(result.structured, REAL_FINDINGS);
});

test("stub JSON auto-continues once via --resume without --session-id or --json-schema", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-grok-continue-"));
  const { scriptPath, captureFile, countFile } = await makeSequentialCli(dir, [
    { text: JSON.stringify(STUB_FINDINGS), sessionId: "sess-stub", num_turns: 1 },
    { text: JSON.stringify(REAL_FINDINGS), sessionId: "sess-stub", num_turns: 2 },
  ]);
  const provider = new GrokHeadlessProvider({
    command: scriptPath,
    promptDir: join(dir, "prompts"),
  });
  const result = await provider.runTurn({
    constructedPrompt: "Review this diff",
    mode: "reviewer",
    timeoutMs: 60_000,
  });
  assert.equal(result.isError, false);
  assert.equal(result.incompleteReview, undefined);
  assert.deepEqual(result.structured, REAL_FINDINGS);
  assert.equal(result.resumed, true);
  const captured = await readFile(captureFile, "utf8");
  assert.match(captured, /INVOCATION=1/);
  assert.match(captured, /INVOCATION=2/);
  const minted = mintedSessionId(captured);
  assert.ok(minted);
  assert.equal(result.nativeSessionId, minted);
  assert.match(captured, new RegExp(`RESUME_ID=${minted}`));
  assert.match(captured, /HAD_SESSION_ID=1/);
  assert.doesNotMatch(captured, /HAD_SESSION_ID=2/);
  assert.doesNotMatch(captured, /HAD_JSON_SCHEMA/);
  assert.doesNotMatch(captured, /--json-schema/);
  const count = await readFile(countFile, "utf8");
  assert.equal(count, "2");
});

test("stub JSON with remaining timeout below 30s floor does not auto-continue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-grok-floor-"));
  const { scriptPath, captureFile, countFile } = await makeSequentialCli(dir, [
    { text: JSON.stringify(STUB_FINDINGS), sessionId: "sess-stub", num_turns: 1 },
  ]);
  const provider = new GrokHeadlessProvider({
    command: scriptPath,
    promptDir: join(dir, "prompts"),
  });
  const result = await provider.runTurn({
    constructedPrompt: "Review this diff",
    mode: "reviewer",
    timeoutMs: 2_000,
  });
  assert.equal(result.isError, true);
  assert.equal(result.incompleteReview, true);
  assert.equal(result.timedOut, undefined);
  assert.match(result.continuationHint ?? "", /idempotency_key/);
  const captured = await readFile(captureFile, "utf8");
  assert.match(captured, /INVOCATION=1/);
  assert.doesNotMatch(captured, /INVOCATION=2/);
  assert.doesNotMatch(captured, /HAD_JSON_SCHEMA/);
  const count = await readFile(countFile, "utf8");
  assert.equal(count, "1");
});

test("repeated stub after auto-continue stays incompleteReview", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-grok-stub-twice-"));
  const { scriptPath, countFile } = await makeSequentialCli(dir, [
    { text: JSON.stringify(STUB_FINDINGS), sessionId: "sess-stub", num_turns: 1 },
  ]);
  const provider = new GrokHeadlessProvider({
    command: scriptPath,
    promptDir: join(dir, "prompts"),
  });
  const result = await provider.runTurn({
    constructedPrompt: "Review this diff",
    mode: "reviewer",
    timeoutMs: 60_000,
  });
  assert.equal(result.isError, true);
  assert.equal(result.incompleteReview, true);
  assert.match(result.continuationHint ?? "", /new idempotency_key/);
  const count = await readFile(countFile, "utf8");
  assert.equal(count, "2");
});

test("implementer stub does not auto-continue with the review continuation prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-grok-impl-stub-"));
  const { scriptPath, captureFile, countFile } = await makeSequentialCli(dir, [
    {
      text: "I'll start by looking at the current implementation.",
      sessionId: "sess-impl-stub",
    },
  ]);
  const provider = new GrokHeadlessProvider({
    command: scriptPath,
    promptDir: join(dir, "prompts"),
  });
  const result = await provider.runTurn({
    constructedPrompt: "Implement the feature",
    mode: "implementer",
    timeoutMs: 60_000,
  });
  assert.equal(result.isError, false);
  assert.equal(result.incompleteReview, undefined);
  const count = await readFile(countFile, "utf8");
  assert.equal(count, "1");
  const captured = await readFile(captureFile, "utf8");
  assert.doesNotMatch(captured, /RESUME_ID=/);
  assert.doesNotMatch(captured, /prefer a single JSON object/);
  assert.doesNotMatch(captured, /Do not narrate setup/);
});

test("timeout with empty text is not treated as a stub and does not auto-continue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-grok-timeout-empty-"));
  const { scriptPath, captureFile } = await makeStreamingCli(dir, [], {
    sleepMs: 1000,
  });
  const provider = new GrokHeadlessProvider({
    command: scriptPath,
    promptDir: join(dir, "prompts"),
  });
  const result = await provider.runTurn({
    constructedPrompt: "Review this diff",
    mode: "reviewer",
    timeoutMs: 400,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.isError, true);
  assert.equal(result.incompleteReview, undefined);
  const captured = await readFile(captureFile, "utf8");
  assert.equal(result.nativeSessionId, mintedSessionId(captured));
  assert.ok(result.nativeSessionId);
});

test("sync runTurn without streamProgress still uses streaming-json and mints --session-id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-grok-always-stream-"));
  const { scriptPath, captureFile } = await makeCaptureCli(dir, {
    text: "ok",
    sessionId: "sess-1",
  });
  const provider = new GrokHeadlessProvider({
    command: scriptPath,
    promptDir: join(dir, "prompts"),
  });
  const result = await provider.runTurn({
    constructedPrompt: "Review",
    mode: "reviewer",
    structuredOutput: false,
  });
  const captured = await readFile(captureFile, "utf8");
  assert.match(captured, /--output-format\nstreaming-json/);
  assert.doesNotMatch(captured, /--resume/);
  assert.equal(result.nativeSessionId, mintedSessionId(captured));
  assert.notEqual(result.nativeSessionId, "sess-1");
});

test("timeout with thought and tool_call returns progress and minted session id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-grok-timeout-tools-"));
  const { scriptPath, captureFile } = await makeStreamingCli(
    dir,
    [
      { type: "thought", data: "inspecting repo" },
      { type: "tool_call", toolName: "read_file", title: "read_file" },
    ],
    { sleepMs: 2000 },
  );
  const provider = new GrokHeadlessProvider({
    command: scriptPath,
    promptDir: join(dir, "prompts"),
  });
  const result = await provider.runTurn({
    constructedPrompt: "Review this diff",
    mode: "reviewer",
    timeoutMs: 400,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.isError, true);
  assert.equal(result.incompleteReview, undefined);
  assert.ok((result.progress?.toolCallCount ?? 0) > 0);
  assert.equal(result.progress?.lastTool, "read_file");
  const captured = await readFile(captureFile, "utf8");
  assert.equal(result.nativeSessionId, mintedSessionId(captured));
  assert.match(captured, /--output-format\nstreaming-json/);
  assert.match(captured, /--session-id\n/);
  assert.doesNotMatch(captured, /HAD_RESUME/);
});

test("grokTurnTimeoutMs ignores PEER_AGENTS_TURN_TIMEOUT_MS", (t) => {
  isolateEnv(t, {
    GROK_TURN_TIMEOUT_MS: undefined,
    PEER_AGENTS_TURN_TIMEOUT_MS: "120000",
  });
  assert.equal(grokTurnTimeoutMs(), DEFAULT_GROK_TURN_TIMEOUT_MS);
  assert.equal(jobTimeoutMsFor("grok"), 1_800_000);
  assert.ok(grokAcpIdleTimeoutMs() >= grokTurnTimeoutMs() + 60_000);
});

test("GROK_TURN_TIMEOUT_MS wins over PEER_AGENTS_TURN_TIMEOUT_MS", (t) => {
  isolateEnv(t, {
    GROK_TURN_TIMEOUT_MS: "5000",
    PEER_AGENTS_TURN_TIMEOUT_MS: "120000",
  });
  assert.equal(grokTurnTimeoutMs(), 5_000);
});

test("with GROK_TURN_TIMEOUT_MS unset and PEER_AGENTS_TURN_TIMEOUT_MS=120000, captured runCommand timeoutMs is 360000", async (t) => {
  isolateEnv(t, {
    GROK_TURN_TIMEOUT_MS: undefined,
    PEER_AGENTS_TURN_TIMEOUT_MS: "120000",
  });
  const capturedTimeouts: number[] = [];
  const dir = await mkdtemp(join(tmpdir(), "peer-grok-default-to-"));
  const { scriptPath } = await makeCaptureCli(dir, { text: "ok", sessionId: "s" });
  const provider = new GrokHeadlessProvider({
    command: scriptPath,
    promptDir: join(dir, "prompts"),
    runCommand: async (options) => {
      capturedTimeouts.push(options.timeoutMs);
      return runCommand(options);
    },
  });
  await provider.runTurn({
    constructedPrompt: "Review",
    mode: "reviewer",
    structuredOutput: false,
  });
  assert.ok(
    capturedTimeouts.includes(DEFAULT_GROK_TURN_TIMEOUT_MS),
    `expected ${DEFAULT_GROK_TURN_TIMEOUT_MS} in ${capturedTimeouts.join(",")}`,
  );
  assert.equal(capturedTimeouts.includes(120_000), false);
});

test("timeoutMs 5000: a 1s fake survives and an 8s fake times out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-grok-env-to-"));
  const fast = await makeStreamingCli(dir, [{ type: "text", data: "ok" }, { type: "end" }], {
    sleepMs: 1000,
  });
  const slowDir = await mkdtemp(join(tmpdir(), "peer-grok-env-to-slow-"));
  const slow = await makeStreamingCli(slowDir, [{ type: "thought", data: "hmm" }], {
    sleepMs: 8000,
  });
  const fastProvider = new GrokHeadlessProvider({
    command: fast.scriptPath,
    promptDir: join(dir, "prompts"),
    timeoutMs: 5_000,
  });
  const slowProvider = new GrokHeadlessProvider({
    command: slow.scriptPath,
    promptDir: join(slowDir, "prompts"),
    timeoutMs: 5_000,
  });
  const survived = await fastProvider.runTurn({
    constructedPrompt: "Review",
    mode: "reviewer",
    structuredOutput: false,
  });
  assert.equal(survived.timedOut, undefined);
  assert.equal(survived.isError, false);
  const timed = await slowProvider.runTurn({
    constructedPrompt: "Review",
    mode: "reviewer",
    structuredOutput: false,
  });
  assert.equal(timed.timedOut, true);
});

test("healthCheck fallback runTurn uses 15s timeout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "peer-grok-health-"));
  const scriptPath = join(dir, "fake-grok.sh");
  await writeFile(
    scriptPath,
    `#!/bin/sh
if [ "$1" = "--version" ]; then exit 1; fi
printf '%s\\n' '{"text":"pong"}'
`,
  );
  await chmod(scriptPath, 0o755);
  const provider = new GrokHeadlessProvider({
    command: scriptPath,
    promptDir: join(dir, "prompts"),
  });
  const timeouts: number[] = [];
  const orig = provider.runTurn.bind(provider);
  provider.runTurn = async (input) => {
    timeouts.push(input.timeoutMs ?? -1);
    return orig(input);
  };
  const health = await provider.healthCheck();
  assert.equal(timeouts[0], HEALTH_TURN_TIMEOUT_MS);
  assert.equal(health.ok, true);
});

test("Grok child env strips parent GROK_SESSION_ID from the spawned process", async (t) => {
  isolateEnv(t, {
    GROK_SESSION_ID: "parent",
    GROK_AGENT: "parent",
    GROK_SESSION: "parent",
  });
  const dir = await mkdtemp(join(tmpdir(), "peer-grok-child-env-"));
  const scriptPath = join(dir, "fake-grok.sh");
  await writeFile(
    scriptPath,
    `#!/bin/sh
printf 'GROK_SESSION_ID=%s\\n' "$GROK_SESSION_ID"
printf 'GROK_AGENT=%s\\n' "$GROK_AGENT"
printf 'GROK_SESSION=%s\\n' "$GROK_SESSION"
echo '{"type":"text","data":"ok"}'
echo '{"type":"end","stopReason":"end_turn"}'
`,
  );
  await chmod(scriptPath, 0o755);
  const provider = new GrokHeadlessProvider({
    command: scriptPath,
    promptDir: join(dir, "prompts"),
  });
  const result = await provider.runTurn({
    constructedPrompt: "Review this diff",
    mode: "reviewer",
    structuredOutput: false,
    timeoutMs: 5_000,
  });
  assert.doesNotMatch(result.stdout, /parent/);
  assert.match(result.stdout, /^GROK_SESSION_ID=$/m);
  assert.doesNotMatch(result.stdout, /GROK_SESSION_ID=parent/);
});
