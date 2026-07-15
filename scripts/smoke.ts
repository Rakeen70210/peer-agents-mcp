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
    if (!p.ok) {
      throw new Error(`provider ${p.provider} unhealthy: ${p.detail ?? "?"}`);
    }
  }

  // Synchronous routed call (creates session + turn) — exercises harness-style MCP use.
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

  let final = asyncJob;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    final = await callTool(client, "peer_job_status", { job_id: asyncJob.jobId });
    if (
      final.status === "succeeded" ||
      final.status === "failed" ||
      final.status === "timed_out" ||
      final.status === "cancelled" ||
      final.status === "orphaned"
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  console.log("async final:", JSON.stringify(final, null, 2));
  if (final.status !== "succeeded") {
    throw new Error(`async job did not succeed: ${final.status}`);
  }

  console.log("smoke: all checks passed");
  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
