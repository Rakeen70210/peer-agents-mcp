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

| Tool                   | Purpose                                      | Routed to     |
|------------------------|----------------------------------------------|---------------|
| `peer_review_diff`     | Review a unified diff or patch               | Grok (usually) |
| `peer_plan`            | Create an implementation plan                | Grok          |
| `peer_debug`           | Diagnose failures from logs/stack traces     | Grok          |
| `peer_verify`          | Check test/build output for safety           | Grok          |
| `peer_ask`             | General grounded Q&A                         | Antigravity   |
| `peer_debate`          | Independently compare Plan A vs Plan B       | Grok          |
| `peer_turn`            | Continue a multi-turn peer session           | Same peer     |
| `peer_turn_async`          | Long-running follow-up turn (background job) | Same peer     |
| `peer_implement_async`     | Cold-start Grok implementation handoff (job) | Grok          |
| `peer_review_diff_async`   | Long-running diff review (background job)    | Grok          |
| `peer_debug_async`         | Long-running debug handoff (background job)  | Grok          |
| `peer_job_status`          | Poll a background job (includes `progress`)  | —             |
| `peer_job_cancel`          | Cancel a background job                      | —             |
| `peer_jobs_gc`             | Garbage-collect old terminal jobs            | —             |
| `peer_compare`             | Low-level side-by-side call to both CLIs     | Both          |

Additional session tools: `peer_summarize`, `peer_transcript`, `peer_list_sessions`, `peer_reset`, and `peer_health`.

All routed tools accept full file contents via the `files` parameter and diffs via `diff`. Never send summaries — send the actual content.

## Long-running async jobs

Large implementation handoffs can exceed the MCP client's synchronous tool timeout. Use the async path instead of blocking on `peer_turn`:

1. Start work with `peer_implement_async` (cold start) or `peer_turn_async` (existing session).
2. Continue local work while the peer runs.
3. Poll `peer_job_status` every **30–60 seconds** (avoid aggressive polling).
4. While `status` is `running`, optional `progress` may include `textSnippet`, `lastThought`, and `eventCount` (Grok streaming-json).
5. When `status` is `succeeded`, read `result` and continue with `peer_turn` if needed.
6. Use `peer_job_cancel` to stop a queued/running job owned by this MCP process.

Terminal statuses: `succeeded`, `failed`, `timed_out`, `cancelled`, `orphaned`.

Idempotency: retries with the same `idempotency_key` return the same job (running or sticky terminal). After `timed_out` / `cancelled` / `failed`, use a **new** key to retry the work.

Jobs and completed results are stored under `~/.peer-agents/jobs/`. Live provider processes do **not** survive MCP server restarts; non-terminal jobs are marked `orphaned` on hydrate (unless the session already committed the operation, which recovers as `succeeded`).

Terminal jobs older than **7 days** are garbage-collected on hydrate (override with `PEER_AGENTS_JOB_GC_MAX_AGE_MS`) or via `peer_jobs_gc`.

Async jobs use a separate timeout from synchronous turns:

- `PEER_AGENTS_JOB_TIMEOUT_MS` — default **30 minutes** (`1800000`)
- `GROK_JOB_TIMEOUT_MS` / `ANTIGRAVITY_JOB_TIMEOUT_MS` — optional per-provider overrides
- `PEER_AGENTS_JOB_GC_MAX_AGE_MS` — terminal job retention (default 7 days)
- `PEER_AGENTS_GROK_TRANSPORT` — `headless` (default) or `acp` for warm process pool
- `PEER_AGENTS_GROK_ACP_MAX_CLIENTS` — max concurrent ACP processes (default 4)
- `PEER_AGENTS_GROK_ACP_IDLE_MS` — idle recycle for ACP processes (default 5 minutes)

Keep the MCP server process alive for the duration of a job.

### Grok transport: headless vs ACP

| | `headless` (default) | `acp` |
|--|----------------------|-------|
| Invocation | `grok --prompt-file` each turn | Long-lived `grok agent stdio` per cwd |
| Latency | Cold start every turn | Warm process; multi-turn reuses process + session |
| CLI features | Full flag matrix (sandbox, json-schema, worktree, …) | Subset (always-approve); structured findings via prompt |
| Enable | *(default)* | `PEER_AGENTS_GROK_TRANSPORT=acp` |

Prefer **headless** for one-shot reviews with strict sandboxing. Prefer **acp** when you run many follow-up `peer_turn`s and want lower process-startup cost.

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
- `ANTIGRAVITY_CONVERSATIONS_DIR` — override agy conversation store used to capture native session ids (default: `~/.gemini/antigravity-cli/conversations`)
- `PEER_AGENTS_STORAGE_DIR` — where sessions are persisted (default: `~/.peer-agents/sessions`)
- `PEER_AGENTS_TURN_TIMEOUT_MS` — per-turn synchronous timeout (default 120s for Grok, 300s for Antigravity)
- `ANTIGRAVITY_TURN_TIMEOUT_MS` — optional Antigravity sync override
- `PEER_AGENTS_JOB_TIMEOUT_MS` — async job timeout (default 30 minutes)
- `GROK_JOB_TIMEOUT_MS` / `ANTIGRAVITY_JOB_TIMEOUT_MS` — optional async per-provider overrides
- `PEER_AGENTS_MAX_PROMPT_CHARS` — safety limit on prompt size

## Multi-turn peer sessions

Each routed call returns a `sessionId`. Use `peer_turn` to continue the conversation:

- Tell the peer what changed
- Attach new diffs or files
- Ask it to re-review or check your fixes

Sessions are persisted to disk, so they survive across restarts of the MCP server.

Grok and Antigravity multi-turn turns prefer **native CLI resume** when a conversation/session id was captured on the first turn; otherwise the MCP rehydrates recent transcript into the prompt.

## Grok CLI integration (0.2.x+)

Grok peer turns use modern headless flags under the hood (callers do not pass these):

| Concern | Behavior |
|---------|----------|
| Large prompts | Always `--prompt-file` (avoids argv limits) |
| Multi-turn | `--resume <nativeSessionId>` when available; falls back to MCP transcript rehydrate |
| Reviewer / planner / critic | `--sandbox read-only`, deny edit tools, no web search |
| Implementer | `--sandbox workspace`, `--always-approve` |
| `peer_implement_async` | Default git `--worktree` isolation (`use_worktree: false` to opt out) |
| Review findings | `--json-schema` structured findings when useful; also returned as `structured` |
| Risk / security | Elevated `--effort` and optional `--check` self-verify |
| Specialists | Packaged `--agent` for security review / architecture planning |
| Async progress | `--output-format streaming-json` + `progress` on `peer_job_status` |
| ACP pool (opt-in) | `PEER_AGENTS_GROK_TRANSPORT=acp` warm process reuse |
| Spend telemetry | `metrics` on results (`usage`, `num_turns`, `stopReason`, cost when present) |

## Antigravity CLI integration (agy 1.1.x+)

Antigravity peer turns use print mode under the hood (callers do not pass these flags):

| Concern | Behavior |
|---------|----------|
| Invocation | `agy -p … --print-timeout … --dangerously-skip-permissions` |
| Multi-turn | `--conversation <id>` when a new conversation was captured after cold start; falls back to MCP transcript rehydrate |
| Session capture | Before/after scan of the conversations store (default `~/.gemini/antigravity-cli/conversations`); only attaches an id when exactly one new `*.db` appears |
| Reviewer / critic | `--sandbox` |
| Planner | `--sandbox --mode plan` |
| Implementer | `--mode accept-edits` |
| Workspace | `--add-dir <cwd>` when a repo path is set |
| Agent | Optional `--agent` when provided |
| Health | Prefer `agy models`; fall back to a short pong turn |

agy does not expose Grok-style json-schema, streaming metrics, worktree, or prompt-file — those remain Grok-only.

## Design notes

- The server never modifies your repo itself — it only runs the CLIs you already have.
- User messages in session transcripts are labeled from the caller's perspective (commonly "Codex").
- Idempotency keys are supported so repeated calls with the same key are safe.
- Context quality hints are returned when the input looks too thin (missing files, diffs, etc.).
- Implementation handoffs default to a Grok worktree so the peer does not clobber a dirty main tree.

## License

MIT (or as specified in the repo).