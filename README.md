# peer-agents-mcp

MCP server that lets other AI coding tools (Codex, Claude, Cursor, etc.) call the **Grok CLI** and **Antigravity CLI** as peer reviewers and collaborators.

## What it does

This server wraps the local `grok` and `agy` (Antigravity) CLIs behind a clean Model Context Protocol (MCP) interface.

Any MCP-capable agent can now:

- Send code changes, plans, errors, or questions to Grok or Antigravity
- Receive structured peer feedback
- Run multi-turn review/debug/planning sessions with session memory
- Get independent opinions by running both CLIs on the same task

The primary agent (Codex, Claude, etc.) stays in control. It simply delegates specific tasks to these peers when it wants a second (or different) opinion.

## Core idea

Instead of one model doing everything, your main coding agent can use Grok and Antigravity **as peers**:

- Grok for most coding work (reviews, planning, debugging, implementation critique)
- Antigravity for large context, general knowledge, or multimodal tasks

Smart routing happens automatically based on the type of request.

## Available tools

| Tool              | Purpose                                      | Routed to     |
|-------------------|----------------------------------------------|---------------|
| `peer_review_diff` | Review a unified diff or patch               | Grok (usually) |
| `peer_plan`        | Create an implementation plan                | Grok          |
| `peer_debug`       | Diagnose failures from logs/stack traces     | Grok          |
| `peer_verify`      | Check test/build output for safety           | Grok          |
| `peer_ask`         | General grounded Q&A                         | Antigravity   |
| `peer_debate`      | Independently compare Plan A vs Plan B       | Grok          |
| `peer_turn`        | Continue a multi-turn peer session           | Same peer     |
| `peer_compare`     | Low-level side-by-side call to both CLIs     | Both          |

Additional session tools: `peer_summarize`, `peer_transcript`, `peer_list_sessions`, `peer_reset`, and `peer_health`.

All routed tools accept full file contents via the `files` parameter and diffs via `diff`. Never send summaries — send the actual content.

## How other agents use it

Codex, Claude, or any other MCP client connects to this server over stdio. Once connected, the agent can call the peer tools exactly like any other tool.

Typical flow:

1. Your agent prepares a diff, error log, or task description.
2. It calls `peer_review_diff`, `peer_plan`, `peer_debug`, etc.
3. The server invokes the appropriate CLI(s) in headless mode.
4. The peer response comes back with a `sessionId`.
5. Your agent can follow up later with `peer_turn` using that `sessionId`.

This gives you persistent, contextual peer conversations without the primary agent having to manage CLI invocation itself.

## Prerequisites

- Node.js ≥ 18
- The `grok` CLI (or set `GROK_COMMAND`)
- The `agy` CLI (Antigravity, or set `ANTIGRAVITY_COMMAND`)

Both CLIs must be authenticated and working on your machine.

## Installation & usage

```bash
git clone https://github.com/Rakeen70210/peer-agents-mcp
cd peer-agents-mcp
npm install
npm run build
```

Run directly:

```bash
node dist/index.js
```

### MCP client configuration

Add it to your client's MCP servers config (example for a typical stdio setup):

```json
{
  "mcpServers": {
    "peer-agents": {
      "command": "node",
      "args": ["/absolute/path/to/peer-agents-mcp/dist/index.js"],
      "env": {
        "GROK_COMMAND": "/home/you/.grok/bin/grok",
        "ANTIGRAVITY_COMMAND": "/home/you/.local/bin/agy"
      }
    }
  }
}
```

## Environment variables

- `GROK_COMMAND` — path to grok binary (default: `grok`)
- `ANTIGRAVITY_COMMAND` — path to agy binary (default: `agy`)
- `GROK_ARGS` / `ANTIGRAVITY_ARGS` — JSON array of extra CLI args
- `PEER_AGENTS_STORAGE_DIR` — where sessions are persisted (default: `~/.peer-agents/sessions`)
- `PEER_AGENTS_TURN_TIMEOUT_MS` — per-turn timeout (default 120s for Grok, 300s for Antigravity)
- `PEER_AGENTS_MAX_PROMPT_CHARS` — safety limit on prompt size

## Multi-turn peer sessions

Each routed call returns a `sessionId`. Use `peer_turn` to continue the conversation:

- Tell the peer what changed
- Attach new diffs or files
- Ask it to re-review or check your fixes

Sessions are persisted to disk, so they survive across restarts of the MCP server.

## Design notes

- The server never modifies your repo itself — it only runs the CLIs you already have.
- User messages in session transcripts are labeled from the caller's perspective (commonly "Codex").
- Idempotency keys are supported so repeated calls with the same key are safe.
- Context quality hints are returned when the input looks too thin (missing files, diffs, etc.).

## License

MIT (or as specified in the repo).