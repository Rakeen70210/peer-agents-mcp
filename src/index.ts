#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createApp } from "./app.js";
import { assessContextQuality, contextQualityHint } from "./context-quality.js";
import {
  complexitySchema,
  diffSchema,
  fileAttachmentSchema,
  filesSchema,
  focusSchema,
  idempotencyKeySchema,
  repoPathSchema,
  riskSchema,
  taskSchema,
} from "./schemas.js";

const providerSchema = z.enum(["grok", "antigravity"]);
const modeSchema = z.enum(["reviewer", "planner", "critic", "implementer"]);

const CONTEXT_PACKING_PREAMBLE =
  "Before calling: read relevant source files and attach full contents via `files`. Pass complete diffs/logs — never prose summaries. Set `task` with goals, affected behavior, and specific concerns.";

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

async function main() {
  const app = createApp();
  await app.hydrate();

  const server = new McpServer({
    name: "peer-agents-mcp",
    version: "0.2.2",
  });

  server.tool(
    "peer_health",
    "Check whether Grok and Antigravity CLIs are responsive",
    {},
    async () => jsonResult(await app.health()),
  );

  server.tool(
    "peer_review_diff",
    `${CONTEXT_PACKING_PREAMBLE} Route a diff review to the best peer model(s) based on focus and risk.`,
    {
      diff: z
        .string()
        .describe(
          "Required. Full unified diff (`git diff`, `git diff --cached`, or patch file). Do not summarize.",
        ),
      repo_path: repoPathSchema,
      focus: focusSchema,
      risk_level: riskSchema,
      files: filesSchema,
      task: taskSchema,
      needs_speed: z
        .boolean()
        .optional()
        .describe("Prefer a faster peer when true; still include full context."),
      idempotency_key: idempotencyKeySchema,
    },
    async (input) =>
      jsonResult(
        await app.routedReviewDiff({
          diff: input.diff,
          repoPath: input.repo_path,
          focus: input.focus,
          riskLevel: input.risk_level,
          files: input.files,
          task: input.task,
          needsSpeed: input.needs_speed,
          idempotencyKey: input.idempotency_key,
        }),
      ),
  );

  server.tool(
    "peer_plan",
    `${CONTEXT_PACKING_PREAMBLE} Route an implementation planning request to the best peer model(s).`,
    {
      task: z
        .string()
        .describe(
          "Required. Goal, success criteria, affected modules, and what 'done' looks like.",
        ),
      repo_path: repoPathSchema,
      constraints: z
        .string()
        .optional()
        .describe(
          "Hard limits: API compatibility, performance budgets, forbidden approaches, deadlines, out-of-scope.",
        ),
      repo_summary: z
        .string()
        .optional()
        .describe(
          "How the repo is structured today — key modules, patterns, and entry points relevant to this task.",
        ),
      risk_level: riskSchema,
      complexity: complexitySchema,
      files: filesSchema,
      idempotency_key: idempotencyKeySchema,
    },
    async (input) =>
      jsonResult(
        await app.routedPlan({
          task: input.task,
          repoPath: input.repo_path,
          constraints: input.constraints,
          repoSummary: input.repo_summary,
          riskLevel: input.risk_level,
          complexity: input.complexity,
          files: input.files,
          idempotencyKey: input.idempotency_key,
        }),
      ),
  );

  server.tool(
    "peer_debug",
    `${CONTEXT_PACKING_PREAMBLE} Route a debugging request after failures.`,
    {
      error_log: z
        .string()
        .describe(
          "Required. Full stderr, stack trace, assertion text, and failing test output — not a one-line summary.",
        ),
      repo_path: repoPathSchema,
      attempted_fixes: z
        .string()
        .optional()
        .describe(
          "Everything already tried and why each failed. Required when failed_attempts > 0.",
        ),
      failed_attempts: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("How many fix attempts have already failed on this bug."),
      diff: diffSchema,
      files: filesSchema,
      task: taskSchema,
      idempotency_key: idempotencyKeySchema,
    },
    async (input) =>
      jsonResult(
        await app.routedDebug({
          errorLog: input.error_log,
          repoPath: input.repo_path,
          attemptedFixes: input.attempted_fixes,
          failedAttempts: input.failed_attempts,
          diff: input.diff,
          files: input.files,
          task: input.task,
          idempotencyKey: input.idempotency_key,
        }),
      ),
  );

  server.tool(
    "peer_verify",
    `${CONTEXT_PACKING_PREAMBLE} Route verification of tests/build output.`,
    {
      test_output: z
        .string()
        .describe(
          "Required. Complete test runner or build output, including failures, skips, and timing if relevant.",
        ),
      repo_path: repoPathSchema,
      diff: diffSchema,
      files: filesSchema,
      task: taskSchema,
      risk_level: riskSchema,
      idempotency_key: idempotencyKeySchema,
    },
    async (input) =>
      jsonResult(
        await app.routedVerify({
          testOutput: input.test_output,
          repoPath: input.repo_path,
          diff: input.diff,
          files: input.files,
          task: input.task,
          riskLevel: input.risk_level,
          idempotencyKey: input.idempotency_key,
        }),
      ),
  );

  server.tool(
    "peer_ask",
    `${CONTEXT_PACKING_PREAMBLE} General knowledge or grounded Q&A — routes to Antigravity.`,
    {
      question: z
        .string()
        .describe(
          "Required. The decision or question, plus what constraints and tradeoffs the answer must address.",
        ),
      repo_path: repoPathSchema,
      context: z
        .string()
        .optional()
        .describe(
          "Background the peer needs: prior decisions, relevant code paths, docs links, or constraints.",
        ),
      files: filesSchema,
      task: taskSchema,
      idempotency_key: idempotencyKeySchema,
    },
    async (input) =>
      jsonResult(
        await app.routedAsk({
          question: input.question,
          repoPath: input.repo_path,
          context: input.context,
          files: input.files,
          task: input.task,
          idempotencyKey: input.idempotency_key,
        }),
      ),
  );

  server.tool(
    "peer_debate",
    `${CONTEXT_PACKING_PREAMBLE} Independently compare Plan A vs Plan B without cross-contamination.`,
    {
      task: z
        .string()
        .describe("What decision this debate must resolve and what success looks like."),
      plan_a: z
        .string()
        .describe("Full Plan A: steps, tradeoffs, risks, and verification approach."),
      plan_b: z
        .string()
        .describe("Full Plan B: steps, tradeoffs, risks, and verification approach."),
      repo_path: repoPathSchema,
      risk_level: riskSchema,
      idempotency_key: idempotencyKeySchema,
    },
    async (input) =>
      jsonResult(
        await app.routedDebate({
          task: input.task,
          planA: input.plan_a,
          planB: input.plan_b,
          repoPath: input.repo_path,
          riskLevel: input.risk_level,
          idempotencyKey: input.idempotency_key,
        }),
      ),
  );

  server.tool(
    "peer_turn",
    `${CONTEXT_PACKING_PREAMBLE} Follow up in an existing routed peer session (use session_id from a prior result).`,
    {
      session_id: z.string().describe("session_id from results.<cli>.sessionId in a prior routed tool response."),
      message: z
        .string()
        .describe(
          "What changed since the last turn, what you fixed, and what you want re-checked.",
        ),
      diff: diffSchema,
      files: filesSchema,
      idempotency_key: idempotencyKeySchema,
      expected_version: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Pass version from the last turn to avoid stale-session races."),
    },
    async (input) => {
      const turnResult = await app.turn({
        sessionId: input.session_id,
        message: input.message,
        diff: input.diff,
        files: input.files,
        idempotencyKey: input.idempotency_key,
        expectedVersion: input.expected_version,
      });
      const contextAdvisory = contextQualityHint(
        assessContextQuality({
          kind: "turn",
          message: input.message,
          diff: input.diff,
          files: input.files,
        }),
      );
      return jsonResult(
        contextAdvisory ? { ...turnResult, contextAdvisory } : turnResult,
      );
    },
  );

  server.tool(
    "peer_compare",
    `${CONTEXT_PACKING_PREAMBLE} Low-level dual-CLI comparison (prefer phase tools for routing).`,
    {
      message: z
        .string()
        .describe("Exact question both peers must answer independently."),
      repo_path: repoPathSchema,
      task: z.string().describe("Short label for this comparison session."),
      providers: z.array(providerSchema).min(1).optional(),
      diff: diffSchema,
      files: filesSchema,
      mode: modeSchema.optional(),
      system: z.string().optional(),
      parallel: z.boolean().optional(),
      idempotency_key: idempotencyKeySchema,
    },
    async (input) => {
      const compareResult = await app.compare({
        message: input.message,
        repoPath: input.repo_path,
        task: input.task,
        providers: input.providers,
        diff: input.diff,
        files: input.files,
        mode: input.mode,
        system: input.system,
        parallel: input.parallel,
        idempotencyKey: input.idempotency_key,
      });
      const contextAdvisory = contextQualityHint(
        assessContextQuality({
          kind: "compare",
          message: input.message,
          diff: input.diff,
          files: input.files,
        }),
      );
      return jsonResult(
        contextAdvisory ? { ...compareResult, contextAdvisory } : compareResult,
      );
    },
  );

  server.tool(
    "peer_summarize",
    "Return the rolling session summary and unresolved issues",
    { session_id: z.string() },
    async (input) => jsonResult(await app.summarize({ sessionId: input.session_id })),
  );

  server.tool(
    "peer_transcript",
    "Export recent transcript turns",
    {
      session_id: z.string(),
      max_turns: z.number().int().positive().optional(),
      format: z.enum(["json", "markdown"]).optional(),
    },
    async (input) =>
      jsonResult(
        await app.transcript({
          sessionId: input.session_id,
          maxTurns: input.max_turns,
          format: input.format,
        }),
      ),
  );

  server.tool(
    "peer_list_sessions",
    "List persisted peer sessions, optionally filtered by repo path",
    { repo_path: z.string().optional() },
    async (input) => jsonResult(await app.listSessions({ repoPath: input.repo_path })),
  );

  server.tool(
    "peer_reset",
    "Clear a session transcript or delete the session entirely",
    {
      session_id: z.string(),
      idempotency_key: idempotencyKeySchema,
      expected_version: z.number().int().nonnegative().optional(),
      keep_metadata: z.boolean().optional(),
    },
    async (input) =>
      jsonResult(
        await app.reset({
          sessionId: input.session_id,
          idempotencyKey: input.idempotency_key,
          expectedVersion: input.expected_version,
          keepMetadata: input.keep_metadata,
        }),
      ),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});