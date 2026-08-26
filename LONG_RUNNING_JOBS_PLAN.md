# Long-Running Peer Jobs Plan

**Status:** Phases 1–4 and 6 are **done** (shipped in-tree). Phase 5 remains optional/not started.

| Phase | Name | Status |
|-------|------|--------|
| 1 | Internal Job Foundation | Done |
| 2 | Execution Plumbing | Done |
| 3 | Async Turn MVP | Done |
| 4 | Cold-Start Implementation Handoff | Done |
| 5 | Optional Routed Async Entry Points | Done |
| 6 | Documentation and Smoke Coverage | Done |

Key files: `src/jobs.ts`, `src/app.ts` (job manager), `src/providers/runner.ts`, `src/providers/{grok,antigravity}-headless.ts`, `src/providers/types.ts`, `src/index.ts`, `tests/jobs.test.ts`, `tests/runner-abort.test.ts`, `README.md`, `scripts/smoke.ts`.

## Problem

Large implementation handoffs can take longer than the MCP client is willing to
hold a synchronous tool call open. When that happens today, the provider process
is killed by the per-turn timeout, the peer's work is lost, and the caller has to
restart from scratch.

This has already happened with a Grok implementation handoff that timed out after
five minutes. Raising the synchronous timeout would only delay the failure mode
and keep the primary agent blocked. We need an async job path that lets the peer
continue independently while the caller polls for status.

The observed failure was a large implementation handoff, not just a follow-up on
an existing peer session. The plan must therefore cover both an async
existing-session turn and a cold-start implementation handoff that creates the
session and job in one call.

## Goals

- [x] Preserve the existing synchronous tools for normal review, planning, debug, and
  verification calls.
- [x] Add an explicit async path for long-running implementation or deep analysis
  tasks.
- [x] Return quickly from async start calls with a stable `jobId` and enough session
  information for follow-up.
- [x] Let callers poll status, retrieve final results, and cancel jobs.
- [x] Persist job metadata and completed results on disk so MCP server restarts do
  not lose terminal job state.
- [x] Keep provider execution bounded by a separate long-running job timeout.
- [x] Reuse the current session, routing, idempotency, and transcript machinery where
  practical.
- [x] Protect live session chains from being replaced by normal hydration while a
  background job is running.
- [x] Make idempotent retries return the same running or terminal job without
  starting duplicate provider work.

## Non-goals

- Do not convert every existing peer tool to background execution.
- Do not stream provider tokens through MCP in this iteration.
- Do not attempt to recover live child processes after an MCP server restart.
  Persisted jobs that were running at shutdown should be marked `orphaned` or
  `failed` with a clear explanation.
- Do not add a separate queue service or daemon.
- Do not guarantee that jobs survive MCP server process exit as live work. The
  host must keep the MCP server process alive for a job to continue running.

## Proposed User Experience

Normal tasks keep using the existing synchronous tools:

```text
peer_review_diff -> immediate peer response
peer_plan        -> immediate peer response
peer_turn        -> immediate peer response
```

Long tasks use the async tools:

```text
peer_turn_async      -> { jobId, sessionId, status: "queued" | "running" }
peer_implement_async -> { jobId, sessionId, status: "queued" | "running" }
peer_job_status      -> { status, result? }
peer_job_cancel      -> { status: "cancelled" }
```

The caller decides when to use async. A typical Codex flow is:

1. Start a large implementation handoff with `peer_implement_async`, or continue
   an existing peer session with `peer_turn_async`.
2. Continue local work while the peer runs.
3. Poll `peer_job_status` every 30-60 seconds.
4. When the job succeeds, inspect the result and continue with `peer_turn` if a
   follow-up is needed.

## Tool API

### `peer_turn_async` — done

Starts a background turn for an existing peer session.

Input should mirror `peer_turn`:

- `session_id`
- `message`
- `idempotency_key`
- `expected_version`
- `diff`
- `files`

Output:

```json
{
  "jobId": "job_...",
  "sessionId": "...",
  "status": "running",
  "createdAt": "2026-07-08T00:00:00.000Z",
  "updatedAt": "2026-07-08T00:00:00.000Z"
}
```

### `peer_implement_async` — done

Starts a background implementation handoff from a cold request. This is the
entry point that directly addresses the observed five-minute Grok handoff
timeout.

Input:

- `task`
- `repo_path`
- `message`
- `idempotency_key`
- `diff`
- `files`
- `system`

Initial implementation routes to Grok and creates an implementer-mode
session before enqueuing the background turn. Later routed async wrappers can
generalize this (Phase 5).

Output:

```json
{
  "jobId": "job_...",
  "sessionId": "...",
  "status": "queued",
  "createdAt": "2026-07-08T00:00:00.000Z",
  "updatedAt": "2026-07-08T00:00:00.000Z"
}
```

### `peer_job_status` — done

Returns current job state and the final result when available.

Input:

- `job_id`

Output while running:

```json
{
  "jobId": "job_...",
  "sessionId": "...",
  "status": "running",
  "createdAt": "2026-07-08T00:00:00.000Z",
  "updatedAt": "2026-07-08T00:03:00.000Z",
  "provider": "grok",
  "task": "large implementation"
}
```

Output after success:

```json
{
  "jobId": "job_...",
  "sessionId": "...",
  "status": "succeeded",
  "result": {
    "sessionId": "...",
    "version": 4,
    "response": "...",
    "stateSummary": "...",
    "isError": false
  }
}
```

Terminal statuses:

- `succeeded`
- `failed`
- `timed_out`
- `cancelled`
- `orphaned`

### `peer_job_cancel` — done

Cancels a running job if the MCP server still owns its child process.

Input:

- `job_id`

Output:

```json
{
  "jobId": "job_...",
  "status": "cancelled",
  "updatedAt": "2026-07-08T00:05:00.000Z"
}
```

If the job already reached a terminal state, return that state without treating
the cancellation request as an error.

## Storage Model — done

Add a jobs directory alongside the existing session and comparison storage:

```text
~/.peer-agents/
  sessions/
  comparisons/
  jobs/
    <safe-job-id>.json
```

Stored job shape:

```ts
type StoredJob = {
  id: string;
  sessionId: string;
  idempotencyKey: string;
  provider: PeerProviderName;
  status: "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "orphaned";
  task: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  timeoutMs: number;
  result?: unknown;
  error?: string;
};
```

Job IDs are deterministic from `(sessionId, idempotencyKey)`, using a safe
hash in the filename. That makes retries after MCP/client timeouts resolve to
the same job without a separate index or directory scan.

Only terminal job state needs to survive restart accurately. In-memory state
holds the live promise and cancellation handle. On MCP server startup or normal
hydration, any persisted `queued` or `running` job without a live in-memory entry
is reconciled to `orphaned` (or synthetic `succeeded` if a committed session
operation exists).

## Runtime Design — done

Introduce a small job manager owned by `createApp`.

Core invariants:

- A session can have only one mutating turn executing at a time. Long async work
  uses the same per-session chain, so it blocks later mutating turns on that
  session until it finishes, fails, times out, or is cancelled.
- `hydrate()` must not replace an in-memory session that has an active chain or a
  live job. It should only add missing sessions or merge disk state in a way that
  preserves the live chain.
- Starting an async job must return quickly. The provider call runs in a
  fire-and-forget background promise with a `.catch()` handler that marks the job
  `failed`.
- `queued` means the job exists but is waiting on the session chain. `running`
  means the provider process has started.
- Terminal jobs are sticky for idempotency. Retrying the same idempotency key
  returns the same terminal job; retrying the work requires a new idempotency key.

Job manager behavior:

- `turnAsync` / schedule path creates or replays a job for the idempotency key.
- It persists `queued` state before scheduling provider execution.
- It stores a live entry in memory containing the promise and abort/cancel hook.
- It executes the same session enqueue path as `peer_turn`, so session ordering
  stays intact.
- It checks `expectedVersion` inside the enqueued task when the job is dequeued,
  not only when the job is accepted. On conflict, mark the job `failed` without
  running the provider or bumping the session version.
- It marks the job `running` when the provider process starts.
- On success, it records the normal turn, commits the operation, persists the
  session, stores the job result, and marks the job `succeeded`.
- On provider timeout, it marks the job `timed_out`.
- On provider or validation error, it marks the job `failed`.
- On cancellation, it kills the child process and marks the job `cancelled`.
- If recovery finds a committed session operation for the job idempotency key,
  the session operation is the source of truth and the job should be reported as
  synthetic `succeeded`.

The provider runner needs cancellation support. Replace the current local timer
only API with an abort-aware variant, and pass timeout/cancellation through the
provider interface:

```ts
type PeerRunInput = {
  constructedPrompt: string;
  cwd?: string;
  mode: PeerMode;
  model?: string;
  files?: PeerFileAttachment[];
  timeoutMs?: number;
  signal?: AbortSignal;
};

runCommand({
  command,
  args,
  cwd,
  stdin,
  timeoutMs,
  signal,
})
```

`runCommand` terminates the child on timeout or abort, preserving stdout
and stderr captured so far for diagnostics. Cancellation settles the
provider promise so the session chain advances. Process-group kill is used on
non-Windows so provider grandchildren do not survive cancellation.

## Timeout Policy — done

Synchronous Grok turns use `GROK_TURN_TIMEOUT_MS` only (default **360000** / 6
minutes). Grok does **not** read `PEER_AGENTS_TURN_TIMEOUT_MS`. Operators who
want the old 120s Grok timeout must set `GROK_TURN_TIMEOUT_MS=120000`.

- Grok sync: `GROK_TURN_TIMEOUT_MS`, default `360000`
- Antigravity sync: `ANTIGRAVITY_TURN_TIMEOUT_MS` or `PEER_AGENTS_TURN_TIMEOUT_MS`,
  default `300000`
- ACP idle (`PEER_AGENTS_GROK_ACP_IDLE_MS`): **between-turns** recycle backstop
  (`max(configured, grokTurnTimeoutMs+60s)`). In-flight `session/prompt` ignores
  idle (`promptDepth`). Idle is **not** the job-lifetime mechanism; 30-minute
  jobs must not depend on idle ≥ 30 min.

Async jobs never inherit a short synchronous timeout by accident:

- `PEER_AGENTS_JOB_TIMEOUT_MS`, default `1800000` (30 minutes)
- `GROK_JOB_TIMEOUT_MS`, optional provider override
- `ANTIGRAVITY_JOB_TIMEOUT_MS`, optional provider override

Both providers accept the per-call job timeout. For Antigravity, the same
timeout is also reflected in `--print-timeout`. Grok headless sync and async
both use `--output-format streaming-json`. Grok reviewer turns do **not** pass
`--json-schema` (that flag aborts the tool loop on 1.0.5).

Intended reviewer/critic/planner permissions (post-stack): `--always-approve`
with the read-only sandbox. This docs change does not alter those flags.

Callers: ordinary diffs use sync tools. Use `*_async` + `peer_job_status` when
the host MCP timeout is ≤ ~3 minutes, the prompt is ≥ ~80k chars (~20k tokens),
near the 120k cap, or truncated, or `risk_level=high` / `focus=security`. Sync
results may include additive `durationAdvisory`; the server does **not**
auto-upgrade sync calls into jobs.

## Idempotency — done

For `peer_turn_async`, use the same idempotency key semantics as `peer_turn`:

Resolution order:

1. If a completed operation result exists on the session, return a synthetic
   succeeded job response containing the existing result.
2. If a live or persisted job with the same `(sessionId, idempotencyKey)` exists,
   return that job.
3. Otherwise create a deterministic job ID from `(sessionId, idempotencyKey)`,
   persist `queued`, and schedule the background task.

This prevents duplicate background peer work when the caller retries after a
network or MCP timeout. Same-key retries after `timed_out`, `cancelled`, or
`failed` do not re-run the provider; callers must use a new idempotency key for a
new attempt.

## Implementation Phases

### Phase 1: Internal Job Foundation — done

- [x] Add job types and persistence helpers in a new `src/jobs.ts`.
- [x] Add `jobsDirFor(storageDir)` and safe job file paths.
- [x] Use deterministic job IDs derived from `(sessionId, idempotencyKey)`.
- [x] Add hydrate-time job reconciliation: persisted `queued` or `running` jobs with
  no live entry become `orphaned`, unless a committed session operation lets the
  job be reported as synthetic `succeeded`.
- [x] Fix or fence `hydrate()` so it does not replace active in-memory sessions and
  their chains.
- [x] Add internal app methods for job lookup and status formatting.
- [x] Add tests for job persistence, deterministic IDs, terminal status loading,
  orphan reconciliation, and unknown job errors.

### Phase 2: Execution Plumbing — done

- [x] Extend `PeerRunInput` with `timeoutMs` and `signal`.
- [x] Extend `runCommand` to accept an abort signal, preserve captured output, and
  settle on timeout or cancellation.
- [x] Pass per-call job timeout through both providers.
- [x] Ensure Antigravity receives the job timeout in `--print-timeout`.
- [x] Track live cancellation handles in the job manager.
- [x] Add async job timeout configuration separate from synchronous turn timeout.
- [x] Add tests for cancellation, timeout, captured diagnostic output, provider
  timeout propagation, and chain release after cancellation.

### Phase 3: Async Turn MVP — done

- [x] Add `peer_turn_async`, `peer_job_status`, and `peer_job_cancel` schemas in
  `src/index.ts`.
- [x] Add `app.turnAsync(...)`, `app.getJobStatus(...)`, and `app.cancelJob(...)`.
- [x] Reuse `buildPrompt`, `runPeerTurn`, `enqueue`, `commitOperation`, and session
  persistence, but start the provider work in a background promise rather than
  awaiting it in the MCP handler.
- [x] Check `expectedVersion` inside the enqueued task.
- [x] Commit successful session operations before marking the job `succeeded`.
- [x] Add tests with fake slow providers proving:
  - async start returns before provider completion,
  - status is `queued` while waiting on the session chain,
  - status is `running` during provider execution,
  - final status is `succeeded`,
  - the session version increments exactly once,
  - duplicate same-key async starts invoke the provider once,
  - same-key terminal retries do not re-run the provider,
  - cancellation releases the session chain.

### Phase 4: Cold-Start Implementation Handoff — done

- [x] Add `peer_implement_async` for large implementation handoffs that do not
  already have a session.
- [x] Create an implementer-mode Grok session and enqueue the first background turn
  in one call.
- [x] Return the same job status shape as `peer_turn_async`.
- [x] Add tests proving the tool creates a session, returns quickly, persists the
  session/job, and records the final transcript once.

### Phase 5: Optional Routed Async Entry Points — done

After `peer_turn_async` and `peer_implement_async` are stable, add routed async
wrappers only where they are useful:

- [x] Optional `peer_review_diff_async` for unusually large reviews.
- [x] Optional `peer_debug_async` for multi-log deep debugging.

Also: streaming-json progress on jobs, terminal job GC, packaged specialist agents.

### Phase 6: Documentation and Smoke Coverage — done

- [x] Document async tools and timeout environment variables in `README.md`.
- [x] Add a smoke script scenario that starts an async job, polls to completion, and
  validates the final result.
- [x] Include guidance that callers should poll every 30-60 seconds rather than
  aggressively.

Note: `scripts/smoke.ts` still depends on a live `peer_start` path that is not
exposed as an MCP tool; the async poll loop was added after the existing turn
path. Unit tests cover the async machinery without requiring real CLIs.

## Test Plan

- [x] Unit test job file save/load and safe filename handling.
- [x] Unit test idempotent `peer_turn_async` retries return the same running job.
- [x] Unit test completed session operations are replayed as succeeded async results.
- [x] Unit test cancellation of a running fake provider.
- [x] Unit test async timeout marks `timed_out` without committing a successful
  session turn.
- [x] Unit test `hydrate()` does not replace a live session with an active chain.
- [x] Unit test persisted `running` and `queued` jobs become `orphaned` after
  restart unless a committed session operation exists.
- [x] Unit test crash-window recovery: committed session operation plus non-terminal
  job file reports synthetic `succeeded` and does not duplicate the transcript.
- [x] Unit test two different async keys on the same session serialize through the
  session chain.
- [x] Unit test `expectedVersion` conflict at dequeue marks the job `failed` without
  invoking the provider.
- [x] Unit test same-key retry after `timed_out` or `cancelled` returns the sticky
  terminal job.
- [ ] Unit test job timeout differs from sync timeout, for example sync timeout is
  very short while job timeout allows a fake delayed provider to complete.
  *(Not added as a dedicated case; async path always uses `jobTimeoutMsFor`,
  separate from provider default sync timeouts.)*
- [x] Unit test Antigravity attachment staging cleanup still runs on abort.
- [x] Integration-style test with a fake delayed provider proving:
  - async start returns before provider completion,
  - status is `running` during execution,
  - final status is `succeeded`,
  - the session version increments exactly once.
- [x] Run `npm test` and `npm run build`.

## Open Questions

- Should `peer_job_status` include partial stdout/stderr while running? This is
  useful for diagnostics but may leak noisy CLI output.
  **Decision so far:** no partial streams in this iteration.
- Should old terminal jobs be garbage collected automatically, and if so after
  how many days?
  **Still open.**
- Should `peer_implement_async` initially allow only Grok, or should it reuse the
  router immediately?
  **Resolved for v1:** Grok-only implementer handoff. Router generalization is Phase 5.
- Should `orphaned` jobs be retryable through a helper, or should all retry
  attempts use a new idempotency key?
  **Resolved for v1:** sticky terminal; callers use a new idempotency key.

## Recommendation

Implement Phases 1-4 as the first useful release. Phases 1-3 provide the
correct async job machinery; Phase 4 applies it to the actual observed failure:
a cold large implementation handoff to Grok. Do not ship `peer_turn_async`
without per-job provider timeout, cancellation, hydrate safety, orphan
reconciliation, and deterministic idempotent job lookup.

**Update:** Phases 1–4 and 6 are implemented and covered by unit tests. Optional
Phase 5 (routed async wrappers) remains backlog until a concrete use case
appears.
