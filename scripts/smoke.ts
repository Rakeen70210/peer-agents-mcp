import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const errText = result.content
      ?.map((item) => ("text" in item ? item.text : ""))
      .join("\n");
    throw new Error(`Tool ${name} failed: ${errText}`);
  }
  const text = result.content
    ?.map((item) => ("text" in item ? item.text : ""))
    .join("\n");
  return text ? JSON.parse(text) : result;
}

async function pollJob(
  client: Client,
  jobId: string,
  label: string,
): Promise<{ final: Record<string, unknown>; sawProgress: boolean }> {
  let final: Record<string, unknown> = { jobId, status: "queued" };
  let sawProgress = false;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    final = await callTool(client, "peer_job_status", { job_id: jobId });
    const progress = final.progress as
      | { eventCount?: number; textSnippet?: string; lastThought?: string }
      | undefined;
    if (progress?.eventCount || progress?.textSnippet || progress?.lastThought) {
      if (!sawProgress) {
        console.log("%s progress:", label, JSON.stringify(progress));
      }
      sawProgress = true;
    }
    const status = String(final.status ?? "");
    if (
      status === "succeeded" ||
      status === "failed" ||
      status === "timed_out" ||
      status === "cancelled" ||
      status === "orphaned"
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  console.log("%s final:", label, JSON.stringify(final, null, 2));
  if (final.status !== "succeeded") {
    throw new Error(`${label} job did not succeed: ${final.status}`);
  }
  return { final, sawProgress };
}

function assertNoRemovedCheckFlag(blob: unknown, label: string) {
  const text = JSON.stringify(blob);
  if (/unexpected argument '--check'/i.test(text) || /unknown argument '--check'/i.test(text)) {
    throw new Error(`${label} still passed removed Grok --check`);
  }
}

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      GROK_COMMAND: process.env.GROK_COMMAND ?? "/home/rakeenhuq/.grok/bin/grok",
      ANTIGRAVITY_COMMAND:
        process.env.ANTIGRAVITY_COMMAND ?? "/home/rakeenhuq/.local/bin/agy",
      PEER_AGENTS_STORAGE_DIR:
        process.env.PEER_AGENTS_STORAGE_DIR ?? "/tmp/peer-agents-smoke",
    },
  });

  const client = new Client({ name: "peer-agents-smoke", version: "0.1.0" });
  await client.connect(transport);

  const listed = await client.listTools();
  const toolNames = listed.tools.map((t) => t.name).sort();
  console.log("tools (%d): %s", toolNames.length, toolNames.join(", "));
  const required = [
    "peer_health",
    "peer_ask",
    "peer_turn",
    "peer_turn_async",
    "peer_review_diff",
    "peer_implement_async",
    "peer_job_status",
  ];
  for (const name of required) {
    if (!toolNames.includes(name)) {
      throw new Error(`missing required tool: ${name}`);
    }
  }

  const health = await callTool(client, "peer_health", {});
  console.log("health:", JSON.stringify(health, null, 2));
  for (const p of health.providers ?? []) {
    if (!p.ok && !p.disabled) {
      throw new Error(`provider ${p.provider} unhealthy: ${p.detail ?? "?"}`);
    }
  }

  // Synchronous routed call (creates session + turn) — exercises harness-style MCP use.
  // peer_ask routes general knowledge to Antigravity (json envelope + --conversation resume).
  const ask = await callTool(client, "peer_ask", {
    question: "Reply with exactly: smoke-ok",
    repo_path: process.cwd(),
    context: "MCP smoke test; one-word style reply is fine.",
    idempotency_key: `smoke-ask-${Date.now()}`,
  });
  console.log("ask:", JSON.stringify(ask, null, 2));
  const askSessionId =
    ask.results?.antigravity?.sessionId ??
    ask.results?.grok?.sessionId ??
    Object.values(ask.results ?? {}).find(
      (r: { sessionId?: string }) => r?.sessionId,
    )?.sessionId;
  if (!askSessionId) {
    throw new Error("peer_ask did not return a sessionId");
  }
  if (ask.partialFailure || ask.allSucceeded === false) {
    throw new Error("peer_ask did not fully succeed");
  }

  const turn = await callTool(client, "peer_turn", {
    session_id: askSessionId,
    message: "Reply with exactly: smoke-turn-ok",
    idempotency_key: `smoke-turn-${Date.now()}`,
    expected_version: 1,
  });
  console.log("turn:", JSON.stringify(turn, null, 2));
  if (turn.isError) {
    throw new Error(`peer_turn failed: ${turn.response ?? "unknown"}`);
  }

  // Async follow-up on the Antigravity session — exercises stream-json job progress.
  const agyAsync = await callTool(client, "peer_turn_async", {
    session_id: askSessionId,
    message: "Reply with exactly: smoke-agy-async-ok",
    idempotency_key: `smoke-agy-async-${Date.now()}`,
    expected_version: turn.version ?? 2,
  });
  console.log("agy async start:", JSON.stringify(agyAsync, null, 2));
  if (!agyAsync.jobId) {
    throw new Error("peer_turn_async did not return jobId");
  }
  const agyDone = await pollJob(client, agyAsync.jobId, "agy async");
  if (agyDone.sawProgress) {
    console.log("agy async: observed peer_job_status.progress (stream-json)");
  } else {
    console.log(
      "agy async: job succeeded without a captured progress snapshot (fast finish is ok)",
    );
  }

  // High-risk Grok review: 1.0 removed --check; this must not hard-fail on that flag.
  const review = await callTool(client, "peer_review_diff", {
    diff: "diff --git a/smoke.txt b/smoke.txt\nindex 1111111..2222222 100644\n--- a/smoke.txt\n+++ b/smoke.txt\n@@ -1 +1 @@\n-old\n+new\n",
    repo_path: process.cwd(),
    focus: "security",
    risk_level: "high",
    task: "Smoke test only. One-sentence review is enough; do not over-investigate.",
    idempotency_key: `smoke-review-${Date.now()}`,
  });
  console.log("review:", JSON.stringify(review, null, 2));
  assertNoRemovedCheckFlag(review, "peer_review_diff");
  if (review.partialFailure || review.allSucceeded === false) {
    throw new Error("peer_review_diff did not fully succeed");
  }

  const asyncJob = await callTool(client, "peer_implement_async", {
    task: "smoke async implement",
    repo_path: process.cwd(),
    message: "Reply with exactly: smoke-async-ok. Do not edit any files.",
    use_worktree: false,
    idempotency_key: `smoke-async-${Date.now()}`,
  });
  console.log("async start:", JSON.stringify(asyncJob, null, 2));
  if (!asyncJob.jobId) {
    throw new Error("peer_implement_async did not return jobId");
  }
  await pollJob(client, asyncJob.jobId, "grok async");

  console.log("smoke: all checks passed");
  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
