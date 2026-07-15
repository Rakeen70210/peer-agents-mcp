import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  const result = await client.callTool({ name, arguments: args });
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
      ANTIGRAVITY_COMMAND: process.env.ANTIGRAVITY_COMMAND ?? "/home/rakeenhuq/.local/bin/agy",
      PEER_AGENTS_STORAGE_DIR:
        process.env.PEER_AGENTS_STORAGE_DIR ?? "/tmp/peer-agents-smoke",
    },
  });

  const client = new Client({ name: "peer-agents-smoke", version: "0.1.0" });
  await client.connect(transport);

  const health = await callTool(client, "peer_health", {});
  console.log("health:", JSON.stringify(health, null, 2));

  const started = await callTool(client, "peer_start", {
    provider: "grok",
    task: "smoke test",
    repo_path: "/home/rakeenhuq",
    mode: "implementer",
  });
  console.log("started:", JSON.stringify(started, null, 2));

  const turn = await callTool(client, "peer_turn", {
    session_id: started.sessionId,
    message: "Reply with exactly: smoke-ok",
    idempotency_key: "smoke-turn-1",
  });
  console.log("turn:", JSON.stringify(turn, null, 2));

  const asyncJob = await callTool(client, "peer_implement_async", {
    task: "smoke async implement",
    repo_path: process.cwd(),
    message: "Reply with exactly: smoke-async-ok",
    idempotency_key: `smoke-async-${Date.now()}`,
  });
  console.log("async start:", JSON.stringify(asyncJob, null, 2));

  let final = asyncJob;
  for (let attempt = 0; attempt < 60; attempt += 1) {
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

  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});