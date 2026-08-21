import { basename } from "node:path";

import { classifyAttachments } from "./attachments.js";
import { resolveRouteSpec, type RoutedProvider } from "./catalog.js";
import {
  assessContextQuality,
  contextQualityHint,
  type ContextQualityInput,
} from "./context-quality.js";
import {
  createStoredJob,
  formatJobStatus,
  gcTerminalJobs,
  isTerminalJobStatus,
  jobIdFrom,
  jobsDirFor,
  loadAllJobsFromDir,
  loadJobFromDir,
  saveJobToDir,
  type JobStatusResponse,
  type StoredJob,
} from "./jobs.js";
import {
  buildTaskPrompt,
  askMessage,
  debateMessage,
  debugMessage,
  planMessage,
  reviewDiffMessage,
  synthesisHint,
  verifyMessage,
} from "./prompts.js";
import { AntigravityHeadlessProvider } from "./providers/antigravity-headless.js";
import { createGrokProvider } from "./providers/grok-factory.js";
import {
  isLikelyResumeFailure,
  sanitizeWorktreeName,
} from "./providers/grok-headless.js";
import type {
  PeerProvider,
  PeerProviderName,
  PeerRunMetrics,
  PeerRunProgress,
  PeerRunResult,
} from "./providers/types.js";
import { parsePositiveInt } from "./providers/runner.js";
import {
  estimateContextTokens,
  hasMultimodalAttachments,
  resolveEnabledProviders,
  routePeerTask,
  type RiskLevel,
  type TaskKind,
} from "./router.js";
import {
  assertExpectedVersion,
  commitOperation,
  createSession,
  comparisonsDirFor,
  defaultStorageDir,
  deleteSessionFromDir,
  getCommittedOperationResult,
  loadAllSessionsFromDir,
  loadComparisonFromDir,
  loadSessionFromDir,
  recentMessages,
  saveComparisonToDir,
  saveSessionToDir,
  type ChatMessage,
  type Session,
} from "./state.js";

export type AppOptions = {
  storageDir?: string;
  comparisonsDir?: string;
  jobsDir?: string;
  providers?: Partial<Record<PeerProviderName, PeerProvider>>;
  maxPromptChars?: number;
  recentTurnCount?: number;
  /** Whitelist of peer CLIs. Env: PEER_AGENTS_ENABLED_PROVIDERS. */
  enabledProviders?: PeerProviderName[];
  /** Blacklist of peer CLIs. Env: PEER_AGENTS_DISABLED_PROVIDERS. */
  disabledProviders?: PeerProviderName[];
};

type MutateInput = {
  sessionId: string;
  idempotencyKey: string;
  expectedVersion?: number;
};

type TurnResult = {
  sessionId: string;
  version: number;
  response: string;
  stateSummary: string;
  nativeSessionId?: string;
  isError?: boolean;
  timedOut?: boolean;
  cancelled?: boolean;
  resumed?: boolean;
  metrics?: PeerRunMetrics;
  structured?: unknown;
  worktreeName?: string;
};

type PeerTurnOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  riskLevel?: RiskLevel;
  complexity?: "simple" | "complex";
  focus?: "bugs" | "architecture" | "security" | "tests" | "general";
  /** Override structured output (default from provider profile). */
  structuredOutput?: boolean;
  selfVerify?: boolean;
  /** Enable Grok streaming-json / agy stream-json progress (async jobs). */
  streamProgress?: boolean;
  onProgress?: (progress: PeerRunProgress) => void;
};

type LiveJob = {
  stored: StoredJob;
  abortController: AbortController;
  promise: Promise<void>;
};

export type CompareProviderResult = {
  provider: PeerProviderName;
  sessionId: string;
  version: number;
  response: string;
  stateSummary: string;
  nativeSessionId?: string;
  isError: boolean;
};

export type CompareResult = {
  idempotencyKey: string;
  comparisonGroup: string;
  providers: PeerProviderName[];
  parallel: boolean;
  results: Partial<Record<PeerProviderName, CompareProviderResult>>;
  allSucceeded: boolean;
  partialFailure: boolean;
};

export type RoutedPeerResult = {
  routedProvider: RoutedProvider;
  modelSource: "cli-default";
  label: string;
  sessionId: string;
  version: number;
  response: string;
  stateSummary: string;
  nativeSessionId?: string;
  isError: boolean;
  resumed?: boolean;
  metrics?: PeerRunMetrics;
  structured?: unknown;
  worktreeName?: string;
};

export type RoutedTaskResult = {
  idempotencyKey: string;
  taskKind: TaskKind;
  task: string;
  risk: RiskLevel;
  routes: RoutedProvider[];
  parallel: boolean;
  rationale: string[];
  results: Partial<Record<RoutedProvider, RoutedPeerResult>>;
  allSucceeded: boolean;
  partialFailure: boolean;
  synthesisHint: string;
  contextAdvisory?: string;
};

const MODE_INSTRUCTIONS: Record<string, string> = {
  reviewer: "Review the work critically. Point out bugs, risks, and regressions.",
  planner: "Propose a concrete plan with ordered steps and tradeoffs.",
  critic: "Challenge assumptions and identify weak points in the approach.",
  implementer:
    "You may edit files, run commands, and implement changes directly when helpful.",
};

const DEFAULT_JOB_TIMEOUT_MS = 1_800_000;

export function jobTimeoutMsFor(provider: PeerProviderName): number {
  if (provider === "grok") {
    return parsePositiveInt(
      process.env.GROK_JOB_TIMEOUT_MS ?? process.env.PEER_AGENTS_JOB_TIMEOUT_MS,
      DEFAULT_JOB_TIMEOUT_MS,
    );
  }
  return parsePositiveInt(
    process.env.ANTIGRAVITY_JOB_TIMEOUT_MS ?? process.env.PEER_AGENTS_JOB_TIMEOUT_MS,
    DEFAULT_JOB_TIMEOUT_MS,
  );
}

export function createApp(options: AppOptions = {}) {
  const storageDir = options.storageDir ?? defaultStorageDir();
  const comparisonsDir =
    options.comparisonsDir ?? comparisonsDirFor(storageDir);
  const jobsDir = options.jobsDir ?? jobsDirFor(storageDir);
  const maxPromptChars =
    options.maxPromptChars ??
    parsePositiveInt(process.env.PEER_AGENTS_MAX_PROMPT_CHARS, 120_000);
  const recentTurnCount = options.recentTurnCount ?? 8;

  const enabledProviders = resolveEnabledProviders({
    enabledProviders: options.enabledProviders,
    disabledProviders: options.disabledProviders,
  });

  const providers: Record<PeerProviderName, PeerProvider> = {
    grok: options.providers?.grok ?? createGrokProvider(),
    antigravity:
      options.providers?.antigravity ?? new AntigravityHeadlessProvider(),
  };

  function assertProviderEnabled(name: PeerProviderName): void {
    if (!enabledProviders.has(name)) {
      throw new Error(
        `Peer provider "${name}" is disabled for this server. ` +
          `Enabled: ${[...enabledProviders].join(", ") || "(none)"}. ` +
          `Set PEER_AGENTS_ENABLED_PROVIDERS or PEER_AGENTS_DISABLED_PROVIDERS.`,
      );
    }
  }

  /** Prefer Grok for coding-shaped jobs; fall back to any enabled peer. */
  function codingProvider(): PeerProviderName {
    if (enabledProviders.has("grok")) return "grok";
    if (enabledProviders.has("antigravity")) return "antigravity";
    throw new Error(
      "No peer providers enabled. Set PEER_AGENTS_ENABLED_PROVIDERS or clear PEER_AGENTS_DISABLED_PROVIDERS.",
    );
  }

  const sessions = new Map<string, Session>();
  const liveJobs = new Map<string, LiveJob>();

  async function persistJob(job: StoredJob): Promise<void> {
    await saveJobToDir(jobsDir, job);
  }

  /**
   * Transition a job only if it is still non-terminal (or already at the
   * requested terminal status). Prevents cancel/timeout/success races from
   * overwriting a sticky terminal state.
   */
  async function transitionJob(
    job: StoredJob,
    next: {
      status: StoredJob["status"];
      result?: unknown;
      error?: string;
      startedAt?: string;
    },
  ): Promise<boolean> {
    if (isTerminalJobStatus(job.status) && job.status !== next.status) {
      return false;
    }
    const now = new Date().toISOString();
    job.status = next.status;
    job.updatedAt = now;
    if (next.startedAt) job.startedAt = next.startedAt;
    if (next.result !== undefined) job.result = next.result;
    if (next.error !== undefined) job.error = next.error;
    if (isTerminalJobStatus(next.status)) {
      job.finishedAt = job.finishedAt ?? now;
    }
    await persistJob(job);
    return true;
  }


  function isJobCancelled(job: StoredJob, signal: AbortSignal): boolean {
    return signal.aborted || job.status === "cancelled";
  }

  async function reconcileJobs(): Promise<void> {
    const allJobs = await loadAllJobsFromDir(jobsDir);
    for (const job of allJobs) {
      if (job.status !== "queued" && job.status !== "running") continue;
      if (liveJobs.has(job.id)) continue;

      let session =
        sessions.get(job.sessionId) ??
        (await loadSessionFromDir(storageDir, job.sessionId));
      if (session && !sessions.has(session.id)) {
        sessions.set(session.id, session);
      }
      if (session) {
        const committed = getCommittedOperationResult<TurnResult>(
          session,
          job.idempotencyKey,
        );
        if (committed !== undefined) {
          job.status = "succeeded";
          job.result = committed;
          job.updatedAt = new Date().toISOString();
          job.finishedAt = job.finishedAt ?? job.updatedAt;
          job.error = undefined;
          await persistJob(job);
          continue;
        }
      }

      job.status = "orphaned";
      job.error =
        "Job was interrupted by MCP server restart; live provider work was not recovered";
      job.updatedAt = new Date().toISOString();
      job.finishedAt = job.finishedAt ?? job.updatedAt;
      await persistJob(job);
    }
  }

  /**
   * Hydrate missing sessions from disk without replacing live in-memory
   * sessions (which would drop active chains / job coordination).
   */
  async function hydrate(): Promise<void> {
    const loaded = await loadAllSessionsFromDir(storageDir);
    for (const session of loaded) {
      if (sessions.has(session.id)) continue;
      sessions.set(session.id, session);
    }
    await reconcileJobs();
    // Best-effort cleanup of old terminal jobs (non-blocking for correctness).
    const maxAgeMs = parsePositiveInt(
      process.env.PEER_AGENTS_JOB_GC_MAX_AGE_MS,
      7 * 24 * 60 * 60 * 1000,
    );
    await gcTerminalJobs(jobsDir, { maxAgeMs }).catch(() => undefined);
  }

  async function persist(session: Session): Promise<void> {
    await saveSessionToDir(storageDir, session);
  }

  function getProvider(name: PeerProviderName): PeerProvider {
    return providers[name];
  }

  function getSession(sessionId: string): Session {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return session;
  }

  function enqueue<T>(session: Session, task: () => Promise<T>): Promise<T> {
    const next = session.chain.then(task, task) as Promise<T>;
    session.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function makeSessionId(input: {
    repoPath: string;
    provider?: PeerProviderName;
    routedProvider?: RoutedProvider;
    task: string;
  }): string {
    const repoSlug = basename(input.repoPath) || "repo";
    const taskSlug = input.task
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    const identity = input.routedProvider ?? input.provider ?? "peer";
    return `${repoSlug}:peer:${identity}:${taskSlug || "task"}`;
  }

  function formatMessage(message: ChatMessage): string {
    const label = message.role === "user" ? "Codex" : message.participant ?? "Peer";
    return `${label}: ${message.content.trim()}`;
  }

  function buildPrompt(
    session: Session,
    input: {
      message: string;
      diff?: string;
      files?: Array<{ path: string; content: string }>;
    },
    options?: { nativeResume?: boolean },
  ): string {
    // Native CLI resume already holds role, history, and prior attachments.
    // Send only the new user request + fresh artifacts.
    if (options?.nativeResume) {
      const lines = [
        "Continue the peer session.",
        "Current request:",
        input.message.trim(),
      ];
      if (input.diff?.trim()) {
        lines.push("", "Diff:", input.diff.trim());
      }
      if (input.files?.length) {
        const { textFiles } = classifyAttachments(input.files);
        if (textFiles.length > 0) {
          lines.push("", "Files:");
          for (const file of textFiles) {
            lines.push(`--- ${file.path} ---`, file.content.trim(), "");
          }
        }
      }
      return redactSecrets(lines.join("\n"));
    }

    const lines = [
      `You are ${session.routedProvider ?? session.provider} acting as a peer agent (CLI default model).`,
      MODE_INSTRUCTIONS[session.mode] ?? MODE_INSTRUCTIONS.reviewer,
      session.mode === "implementer"
        ? "You may edit files and run commands in the repo when that helps complete the task."
        : "Prefer analysis over edits. Do not modify project files unless explicitly required.",
      "",
      `Task: ${session.task}`,
    ];

    if (session.system?.trim()) {
      lines.push("", "Additional instructions:", session.system.trim());
    }

    if (session.summary?.trim()) {
      lines.push("", "Session summary:", session.summary.trim());
    }

    const turns = recentMessages(session, recentTurnCount);
    if (turns.length > 0) {
      lines.push("", "Recent turns:");
      for (const turn of turns) {
        lines.push(formatMessage(turn));
      }
    }

    lines.push("", "Current request:", input.message.trim());

    if (input.diff?.trim()) {
      lines.push("", "Diff:", input.diff.trim());
    }

    if (input.files?.length) {
      const { textFiles } = classifyAttachments(input.files);
      if (textFiles.length > 0) {
        lines.push("", "Files:");
        for (const file of textFiles) {
          lines.push(`--- ${file.path} ---`, file.content.trim(), "");
        }
      }
    }

    return redactSecrets(lines.join("\n"));
  }

  function stateSummary(session: Session): string {
    const turns = session.messages.length;
    const last = session.messages.at(-1);
    const preview = last?.content.slice(0, 160).replace(/\s+/g, " ") ?? "";
    return [
      `provider=${session.provider}`,
      `mode=${session.mode}`,
      `turns=${turns}`,
      `version=${session.version}`,
      preview ? `last="${preview}"` : "last=none",
    ].join("; ");
  }

  async function recordTurn(
    session: Session,
    userMessage: string,
    peerResult: PeerRunResult,
  ): Promise<void> {
    const now = new Date().toISOString();
    session.messages.push({
      role: "user",
      content: userMessage,
      createdAt: now,
      participant: "codex",
    });
    session.messages.push({
      role: "assistant",
      content: peerResult.text,
      createdAt: now,
      participant: session.provider,
    });
    if (peerResult.nativeSessionId) {
      session.nativeSessionId = peerResult.nativeSessionId;
    }
    session.version += 1;
    session.updatedAt = now;
    session.summary = deriveSummary(session);
    await persist(session);
  }

  function deriveSummary(session: Session): string {
    const recent = session.messages.slice(-6);
    if (recent.length === 0) return session.summary ?? "";
    return recent
      .map((message) => `${message.participant ?? message.role}: ${message.content}`)
      .join("\n")
      .slice(0, 4000);
  }

  function toTurnResult(
    session: Session,
    peerResult: PeerRunResult,
    flags?: { isError?: boolean; timedOut?: boolean; cancelled?: boolean },
  ): TurnResult {
    return {
      sessionId: session.id,
      version: session.version,
      response:
        flags?.cancelled || flags?.timedOut || flags?.isError
          ? peerResult.stderr || peerResult.text || "Error"
          : peerResult.text,
      stateSummary: stateSummary(session),
      nativeSessionId:
        peerResult.nativeSessionId ?? session.nativeSessionId ?? undefined,
      isError: flags?.isError ?? peerResult.isError ?? false,
      timedOut: flags?.timedOut,
      cancelled: flags?.cancelled,
      resumed: peerResult.resumed,
      metrics: peerResult.metrics,
      structured: peerResult.structured,
      worktreeName: peerResult.worktreeName ?? session.worktreeName,
    };
  }

  async function invokeProvider(
    session: Session,
    constructedPrompt: string,
    files: Array<{ path: string; content: string }> | undefined,
    runOptions: PeerTurnOptions | undefined,
    nativeSessionId: string | undefined,
  ): Promise<PeerRunResult> {
    const provider = getProvider(session.provider);
    return provider.runTurn({
      constructedPrompt,
      cwd: session.repoPath,
      mode: session.mode,
      files,
      timeoutMs: runOptions?.timeoutMs,
      signal: runOptions?.signal,
      nativeSessionId,
      riskLevel: runOptions?.riskLevel,
      complexity: runOptions?.complexity,
      focus: runOptions?.focus,
      worktree: session.worktreeName,
      structuredOutput: runOptions?.structuredOutput,
      selfVerify: runOptions?.selfVerify,
      streamProgress: runOptions?.streamProgress,
      onProgress: runOptions?.onProgress,
    });
  }

  async function runPeerTurn(
    session: Session,
    input: {
      message: string;
      diff?: string;
      files?: Array<{ path: string; content: string }>;
    },
    userMessageForTranscript: string,
    runOptions?: PeerTurnOptions,
  ): Promise<TurnResult> {
    // Grok uses --resume; Antigravity uses --conversation (both via nativeSessionId).
    const canResume =
      (session.provider === "grok" || session.provider === "antigravity") &&
      Boolean(session.nativeSessionId);

    if (canResume) {
      const compact = enforcePromptLimit(
        buildPrompt(session, input, { nativeResume: true }),
      );
      const resumed = await invokeProvider(
        session,
        compact,
        input.files,
        runOptions,
        session.nativeSessionId,
      );

      if (resumed.cancelled || runOptions?.signal?.aborted) {
        return toTurnResult(session, resumed, {
          isError: true,
          cancelled: true,
        });
      }
      if (resumed.timedOut) {
        return toTurnResult(session, resumed, { isError: true, timedOut: true });
      }
      if (!resumed.isError) {
        await recordTurn(session, userMessageForTranscript, resumed);
        return toTurnResult(session, resumed);
      }
      if (!isLikelyResumeFailure(resumed)) {
        return toTurnResult(session, resumed, { isError: true });
      }
      // Native session lost — fall back to MCP transcript rehydrate.
      session.nativeSessionId = undefined;
    }

    const full = enforcePromptLimit(buildPrompt(session, input));
    const peerResult = await invokeProvider(
      session,
      full,
      input.files,
      runOptions,
      undefined,
    );

    if (peerResult.cancelled || runOptions?.signal?.aborted) {
      return toTurnResult(session, peerResult, {
        isError: true,
        cancelled: true,
      });
    }
    if (peerResult.timedOut) {
      return toTurnResult(session, peerResult, {
        isError: true,
        timedOut: true,
      });
    }
    if (!peerResult.isError) {
      if (peerResult.worktreeName && !session.worktreeName) {
        session.worktreeName = peerResult.worktreeName;
      }
      await recordTurn(session, userMessageForTranscript, peerResult);
    }

    return toTurnResult(session, peerResult, {
      isError: peerResult.isError ? true : undefined,
    });
  }

  function enforcePromptLimit(prompt: string): string {
    if (prompt.length <= maxPromptChars) return prompt;
    const marker = "\n\n[TRUNCATED: prompt exceeded PEER_AGENTS_MAX_PROMPT_CHARS]\n";
    return prompt.slice(0, maxPromptChars - marker.length) + marker;
  }

  function syntheticSucceededJob(
    session: Session,
    idempotencyKey: string,
    result: TurnResult,
  ): JobStatusResponse {
    const now = new Date().toISOString();
    return formatJobStatus({
      id: jobIdFrom(session.id, idempotencyKey),
      sessionId: session.id,
      idempotencyKey,
      provider: session.provider,
      status: "succeeded",
      task: session.task,
      createdAt: now,
      updatedAt: now,
      finishedAt: now,
      timeoutMs: jobTimeoutMsFor(session.provider),
      result,
    });
  }

  async function resolveJob(jobId: string): Promise<StoredJob> {
    const live = liveJobs.get(jobId);
    if (live) return live.stored;

    const loaded = await loadJobFromDir(jobsDir, jobId);
    if (!loaded) {
      throw new Error(`Unknown job: ${jobId}`);
    }

    // Crash-window recovery: committed session op is source of truth.
    if (loaded.status === "queued" || loaded.status === "running") {
      const session =
        sessions.get(loaded.sessionId) ??
        (await loadSessionFromDir(storageDir, loaded.sessionId));
      if (session) {
        if (!sessions.has(session.id)) sessions.set(session.id, session);
        const committed = getCommittedOperationResult<TurnResult>(
          session,
          loaded.idempotencyKey,
        );
        if (committed !== undefined) {
          loaded.status = "succeeded";
          loaded.result = committed;
          loaded.updatedAt = new Date().toISOString();
          loaded.finishedAt = loaded.finishedAt ?? loaded.updatedAt;
          loaded.error = undefined;
          await persistJob(loaded);
        }
      }
    }

    return loaded;
  }

  function scheduleTurnJob(input: {
    session: Session;
    job: StoredJob;
    message: string;
    diff?: string;
    files?: Array<{ path: string; content: string }>;
    expectedVersion?: number;
    riskLevel?: RiskLevel;
    focus?: "bugs" | "architecture" | "security" | "tests" | "general";
    complexity?: "simple" | "complex";
  }): LiveJob {
    const { session, job } = input;
    const abortController = new AbortController();

    const promise = (async () => {
      try {
        await enqueue(session, async () => {
          if (isTerminalJobStatus(job.status) || abortController.signal.aborted) {
            if (!isTerminalJobStatus(job.status)) {
              await transitionJob(job, {
                status: "cancelled",
                error: "Cancelled by caller",
              });
            }
            return;
          }

          const replay = getCommittedOperationResult<TurnResult>(
            session,
            job.idempotencyKey,
          );
          if (replay !== undefined) {
            await transitionJob(job, { status: "succeeded", result: replay });
            return;
          }

          try {
            assertExpectedVersion(session, input.expectedVersion);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            await transitionJob(job, { status: "failed", error: message });
            return;
          }

          if (abortController.signal.aborted) {
            await transitionJob(job, {
              status: "cancelled",
              error: "Cancelled by caller",
            });
            return;
          }

          const startedAt = new Date().toISOString();
          await transitionJob(job, { status: "running", startedAt });

          try {
            let lastProgressWrite = 0;
            const result = await runPeerTurn(
              session,
              {
                message: input.message,
                diff: input.diff,
                files: input.files,
              },
              input.message,
              {
                timeoutMs: job.timeoutMs,
                signal: abortController.signal,
                streamProgress: true,
                riskLevel: input.riskLevel,
                focus: input.focus,
                complexity: input.complexity,
                onProgress: (progress) => {
                  job.progress = progress;
                  job.updatedAt = progress.updatedAt;
                  const now = Date.now();
                  // Throttle disk writes to ~1/s while streaming.
                  if (now - lastProgressWrite >= 1000) {
                    lastProgressWrite = now;
                    void persistJob(job);
                  }
                },
              },
            );

            if (result.cancelled || isJobCancelled(job, abortController.signal)) {
              await transitionJob(job, {
                status: "cancelled",
                error: result.response || "Cancelled by caller",
              });
              return;
            }

            if (result.timedOut) {
              await transitionJob(job, {
                status: "timed_out",
                error: result.response || `Timed out after ${job.timeoutMs}ms`,
              });
              return;
            }

            if (result.isError) {
              await transitionJob(job, {
                status: "failed",
                error: result.response || "Provider returned an error",
              });
              return;
            }

            // Re-check cancellation after provider success before commit.
            if (isJobCancelled(job, abortController.signal)) {
              await transitionJob(job, {
                status: "cancelled",
                error: "Cancelled by caller",
              });
              return;
            }

            commitOperation(session, job.idempotencyKey, result);
            await persist(session);
            await transitionJob(job, { status: "succeeded", result });
          } catch (error) {
            if (isJobCancelled(job, abortController.signal)) {
              await transitionJob(job, {
                status: "cancelled",
                error: "Cancelled by caller",
              });
              return;
            }
            const message =
              error instanceof Error ? error.message : String(error);
            await transitionJob(job, { status: "failed", error: message });
          }
        });
      } catch (error) {
        if (!isTerminalJobStatus(job.status)) {
          const message =
            error instanceof Error ? error.message : String(error);
          await transitionJob(job, { status: "failed", error: message });
        }
      } finally {
        // Keep terminal job on disk; drop only the live handle.
        liveJobs.delete(job.id);
      }
    })();

    // Ensure unhandled rejections never crash the MCP process.
    promise.catch(() => undefined);

    const live: LiveJob = { stored: job, abortController, promise };
    liveJobs.set(job.id, live);
    return live;
  }

  const app = {
    hydrate,
    async health() {
      const results = await Promise.all(
        (Object.keys(providers) as PeerProviderName[]).map(async (name) => {
          if (!enabledProviders.has(name)) {
            return {
              provider: name,
              ok: false,
              latencyMs: 0,
              disabled: true,
              detail: "disabled (PEER_AGENTS_ENABLED_PROVIDERS / PEER_AGENTS_DISABLED_PROVIDERS)",
            };
          }
          const result = await providers[name].healthCheck();
          return { provider: name, disabled: false, ...result };
        }),
      );
      return {
        providers: results,
        enabledProviders: [...enabledProviders],
      };
    },

    async start(input: {
      provider: PeerProviderName;
      routedProvider?: RoutedProvider;
      model?: string;
      task: string;
      repoPath: string;
      mode?: Session["mode"];
      system?: string;
      sessionId?: string;
      worktreeName?: string;
    }) {
      await hydrate();
      assertProviderEnabled(input.provider);
      const id =
        input.sessionId ??
        makeSessionId({
          repoPath: input.repoPath,
          provider: input.provider,
          routedProvider: input.routedProvider,
          task: input.task,
        });

      const existing = sessions.get(id) ?? (await loadSessionFromDir(storageDir, id));
      if (existing) {
        // Prefer the live in-memory session so we do not replace an active chain.
        if (!sessions.has(id)) {
          sessions.set(id, existing);
        }
        const live = sessions.get(id)!;
        return {
          sessionId: id,
          resumed: true,
          stateSummary: stateSummary(live),
          worktreeName: live.worktreeName,
        };
      }

      const session = createSession({
        id,
        provider: input.provider,
        routedProvider: input.routedProvider,
        model: input.model,
        task: input.task,
        repoPath: input.repoPath,
        mode: input.mode ?? "implementer",
        system: input.system,
        worktreeName: input.worktreeName,
      });
      sessions.set(id, session);
      await persist(session);
      return {
        sessionId: id,
        resumed: false,
        stateSummary: stateSummary(session),
        worktreeName: session.worktreeName,
      };
    },

    async executeRouted(input: {
      kind: TaskKind;
      task: string;
      repoPath: string;
      message: string;
      diff?: string;
      files?: Array<{ path: string; content: string }>;
      risk?: RiskLevel;
      failedAttempts?: number;
      needsSpeed?: boolean;
      needsDeepReasoning?: boolean;
      complexity?: "simple" | "complex";
      focus?: "bugs" | "architecture" | "security" | "tests" | "general";
      mode?: Session["mode"];
      idempotencyKey: string;
      contextTokensEstimate?: number;
      constraints?: string;
      repoSummary?: string;
      errorLog?: string;
      attemptedFixes?: string;
      testOutput?: string;
      question?: string;
      context?: string;
      planA?: string;
      planB?: string;
    }): Promise<RoutedTaskResult> {
      await hydrate();

      const replay = await loadComparisonFromDir(comparisonsDir, input.idempotencyKey);
      if (replay) {
        return replay as RoutedTaskResult;
      }

      const contextTokensEstimate =
        input.contextTokensEstimate ??
        estimateContextTokens([
          input.message,
          input.diff,
          input.files
            ? classifyAttachments(input.files).textFiles
                .map((file) => file.content)
                .join("\n")
            : undefined,
        ]);
      const decision = routePeerTask({
        kind: input.kind,
        risk: input.risk,
        contextTokensEstimate,
        hasImagesOrPdf: hasMultimodalAttachments(input.files),
        failedAttempts: input.failedAttempts,
        needsSpeed: input.needsSpeed,
        needsDeepReasoning: input.needsDeepReasoning,
        complexity: input.complexity,
        focus: input.focus,
        enabledProviders,
      });

      const independentReview = decision.routes.length > 1;
      const promptMessage = buildTaskPrompt({
        kind: input.kind,
        message: input.message,
        diff: input.diff,
        files: input.files,
        independentReview,
      });

      const runRoute = async (route: RoutedProvider): Promise<RoutedPeerResult> => {
        const spec = resolveRouteSpec(route);
        const started = await app.start({
          provider: spec.cli,
          routedProvider: route,
          task: input.task,
          repoPath: input.repoPath,
          mode: input.mode ?? modeForKind(input.kind),
        });
        const session = getSession(started.sessionId);
        return enqueue(session, async () => {
          const mode = input.mode ?? modeForKind(input.kind);
          const result = await runPeerTurn(
            session,
            {
              message: promptMessage,
              diff: input.diff,
              files: input.files,
            },
            input.message,
            {
              riskLevel: input.risk,
              complexity: input.complexity,
              focus: input.focus,
              structuredOutput:
                mode === "planner" || mode === "implementer" ? false : undefined,
            },
          );
          return {
            routedProvider: route,
            modelSource: spec.modelSource,
            label: spec.label,
            sessionId: result.sessionId,
            version: result.version,
            response: result.response,
            stateSummary: result.stateSummary,
            nativeSessionId: result.nativeSessionId,
            isError: result.isError ?? false,
            resumed: result.resumed,
            metrics: result.metrics,
            structured: result.structured,
            worktreeName: result.worktreeName,
          };
        });
      };

      const routeResults = decision.parallel
        ? await Promise.all(decision.routes.map(runRoute))
        : await decision.routes.reduce(
            async (chain, route) => {
              const accumulated = await chain;
              accumulated.push(await runRoute(route));
              return accumulated;
            },
            Promise.resolve([] as RoutedPeerResult[]),
          );

      const results: Partial<Record<RoutedProvider, RoutedPeerResult>> = {};
      for (const entry of routeResults) {
        results[entry.routedProvider] = entry;
      }

      const contextWarnings = assessContextQuality(
        contextQualityInputForKind(input.kind, input),
      );
      const routedResult: RoutedTaskResult = {
        idempotencyKey: input.idempotencyKey,
        taskKind: input.kind,
        task: input.task,
        risk: input.risk ?? "medium",
        routes: decision.routes,
        parallel: decision.parallel,
        rationale: decision.rationale,
        results,
        allSucceeded: routeResults.every((entry) => !entry.isError),
        partialFailure:
          routeResults.some((entry) => entry.isError) &&
          routeResults.some((entry) => !entry.isError),
        synthesisHint: synthesisHint(decision.routes.length),
        contextAdvisory: contextQualityHint(contextWarnings),
      };

      await saveComparisonToDir(comparisonsDir, input.idempotencyKey, routedResult);
      return routedResult;
    },

    async routedReviewDiff(input: {
      diff: string;
      repoPath: string;
      focus?: "bugs" | "architecture" | "security" | "tests" | "general";
      riskLevel?: RiskLevel;
      files?: Array<{ path: string; content: string }>;
      task?: string;
      needsSpeed?: boolean;
      idempotencyKey: string;
    }) {
      const focus = input.focus ?? "general";
      const kind: TaskKind =
        focus === "security"
          ? "security"
          : focus === "architecture"
            ? "architecture"
            : "review_diff";
      return app.executeRouted({
        kind,
        task: input.task ?? `review-diff:${focus}`,
        repoPath: input.repoPath,
        message: reviewDiffMessage(focus),
        diff: input.diff,
        files: input.files,
        risk: input.riskLevel,
        needsSpeed: input.needsSpeed,
        focus,
        mode: "reviewer",
        idempotencyKey: input.idempotencyKey,
      });
    },

    async routedPlan(input: {
      task: string;
      repoPath: string;
      constraints?: string;
      repoSummary?: string;
      riskLevel?: RiskLevel;
      complexity?: "simple" | "complex";
      files?: Array<{ path: string; content: string }>;
      idempotencyKey: string;
    }) {
      return app.executeRouted({
        kind: "plan",
        task: input.task,
        repoPath: input.repoPath,
        message: planMessage({
          task: input.task,
          constraints: input.constraints,
          repoSummary: input.repoSummary,
        }),
        files: input.files,
        risk: input.riskLevel,
        complexity: input.complexity,
        mode: "planner",
        idempotencyKey: input.idempotencyKey,
        constraints: input.constraints,
        repoSummary: input.repoSummary,
      });
    },

    async routedDebug(input: {
      errorLog: string;
      repoPath: string;
      attemptedFixes?: string;
      failedAttempts?: number;
      diff?: string;
      files?: Array<{ path: string; content: string }>;
      task?: string;
      idempotencyKey: string;
    }) {
      return app.executeRouted({
        kind: "debug",
        task: input.task ?? "debug-failure",
        repoPath: input.repoPath,
        message: debugMessage({
          errorLog: input.errorLog,
          attemptedFixes: input.attemptedFixes,
        }),
        diff: input.diff,
        files: input.files,
        failedAttempts: input.failedAttempts,
        mode: "critic",
        idempotencyKey: input.idempotencyKey,
        errorLog: input.errorLog,
        attemptedFixes: input.attemptedFixes,
      });
    },

    async routedVerify(input: {
      testOutput: string;
      repoPath: string;
      diff?: string;
      files?: Array<{ path: string; content: string }>;
      task?: string;
      riskLevel?: RiskLevel;
      idempotencyKey: string;
    }) {
      return app.executeRouted({
        kind: "verify",
        task: input.task ?? "verify-change",
        repoPath: input.repoPath,
        message: verifyMessage({ testOutput: input.testOutput }),
        diff: input.diff,
        files: input.files,
        risk: input.riskLevel,
        mode: "reviewer",
        idempotencyKey: input.idempotencyKey,
        testOutput: input.testOutput,
      });
    },

    async routedDebate(input: {
      task: string;
      planA: string;
      planB: string;
      repoPath: string;
      riskLevel?: RiskLevel;
      idempotencyKey: string;
    }) {
      return app.executeRouted({
        kind: "debate",
        task: input.task,
        repoPath: input.repoPath,
        message: debateMessage({
          task: input.task,
          planA: input.planA,
          planB: input.planB,
        }),
        risk: input.riskLevel,
        mode: "critic",
        idempotencyKey: input.idempotencyKey,
        planA: input.planA,
        planB: input.planB,
      });
    },

    async routedAsk(input: {
      question: string;
      repoPath: string;
      context?: string;
      files?: Array<{ path: string; content: string }>;
      task?: string;
      idempotencyKey: string;
    }) {
      return app.executeRouted({
        kind: "general_knowledge",
        task: input.task ?? "general-question",
        repoPath: input.repoPath,
        message: askMessage({
          question: input.question,
          context: input.context,
        }),
        files: input.files,
        mode: "reviewer",
        idempotencyKey: input.idempotencyKey,
        question: input.question,
        context: input.context,
      });
    },

    async turn(input: MutateInput & {
      message: string;
      diff?: string;
      files?: Array<{ path: string; content: string }>;
    }) {
      await hydrate();
      const session = getSession(input.sessionId);
      return enqueue(session, async () => {
        const replay = getCommittedOperationResult<TurnResult>(
          session,
          input.idempotencyKey,
        );
        if (replay) return replay;

        assertExpectedVersion(session, input.expectedVersion);
        const result = await runPeerTurn(
          session,
          {
            message: input.message,
            diff: input.diff,
            files: input.files,
          },
          input.message,
        );
        commitOperation(session, input.idempotencyKey, result);
        await persist(session);
        return result;
      });
    },

    /**
     * Start a background turn for an existing session. Returns immediately
     * with job metadata; poll getJobStatus for completion.
     */
    async turnAsync(input: MutateInput & {
      message: string;
      diff?: string;
      files?: Array<{ path: string; content: string }>;
      riskLevel?: RiskLevel;
      focus?: "bugs" | "architecture" | "security" | "tests" | "general";
      complexity?: "simple" | "complex";
    }): Promise<JobStatusResponse> {
      await hydrate();
      const session = getSession(input.sessionId);
      const jobId = jobIdFrom(session.id, input.idempotencyKey);

      const committed = getCommittedOperationResult<TurnResult>(
        session,
        input.idempotencyKey,
      );
      if (committed !== undefined) {
        return syntheticSucceededJob(session, input.idempotencyKey, committed);
      }

      const live = liveJobs.get(jobId);
      if (live) {
        return formatJobStatus(live.stored);
      }

      const persisted = await loadJobFromDir(jobsDir, jobId);
      if (persisted) {
        // Sticky terminal / orphaned jobs: never re-run same key.
        if (isTerminalJobStatus(persisted.status)) {
          // Recover succeeded from committed op if present.
          if (
            persisted.status !== "succeeded" &&
            (persisted.status === "queued" ||
              persisted.status === "running" ||
              persisted.status === "orphaned")
          ) {
            // no-op: terminal non-succeeded stays sticky
          }
          const committedAgain = getCommittedOperationResult<TurnResult>(
            session,
            input.idempotencyKey,
          );
          if (committedAgain !== undefined && persisted.status !== "succeeded") {
            // Crash window: session committed but job file not updated.
            await transitionJob(persisted, {
              status: "succeeded",
              result: committedAgain,
            });
          }
          return formatJobStatus(persisted);
        }
        // Non-terminal without live entry should have been orphaned on hydrate.
        // Still sticky: do not start a duplicate provider.
        return formatJobStatus(persisted);
      }

      const job = createStoredJob({
        id: jobId,
        sessionId: session.id,
        idempotencyKey: input.idempotencyKey,
        provider: session.provider,
        task: session.task,
        timeoutMs: jobTimeoutMsFor(session.provider),
        status: "queued",
      });
      await persistJob(job);
      scheduleTurnJob({
        session,
        job,
        message: input.message,
        diff: input.diff,
        files: input.files,
        expectedVersion: input.expectedVersion,
        riskLevel: input.riskLevel,
        focus: input.focus,
        complexity: input.complexity,
      });
      return formatJobStatus(job);
    },

    /**
     * Cold-start large implementation handoff: create an implementer Grok
     * session and enqueue the first background turn in one call.
     */
    async implementAsync(input: {
      task: string;
      repoPath: string;
      message: string;
      idempotencyKey: string;
      diff?: string;
      files?: Array<{ path: string; content: string }>;
      system?: string;
      /** Opt out of git worktree isolation (default: isolated worktree). */
      useWorktree?: boolean;
    }): Promise<JobStatusResponse> {
      const provider = codingProvider();
      // Worktree isolation is a Grok CLI feature; skip when only Antigravity is enabled.
      const useWorktree = provider === "grok" && input.useWorktree !== false;
      const worktreeName = useWorktree
        ? sanitizeWorktreeName(
            `peer-impl-${makeSessionId({
              repoPath: input.repoPath,
              provider,
              task: input.task,
            }).slice(0, 12)}`,
          )
        : undefined;
      const started = await app.start({
        provider,
        task: input.task,
        repoPath: input.repoPath,
        mode: "implementer",
        system: input.system,
        worktreeName,
      });
      return app.turnAsync({
        sessionId: started.sessionId,
        message: input.message,
        idempotencyKey: input.idempotencyKey,
        diff: input.diff,
        files: input.files,
      });
    },

    /**
     * Long-running diff review as a background job (large monorepo reviews).
     * Routes to the preferred coding peer (Grok when enabled, else Antigravity).
     */
    async reviewDiffAsync(input: {
      diff: string;
      repoPath: string;
      idempotencyKey: string;
      focus?: "bugs" | "architecture" | "security" | "tests" | "general";
      riskLevel?: RiskLevel;
      files?: Array<{ path: string; content: string }>;
      task?: string;
    }): Promise<JobStatusResponse> {
      const focus = input.focus ?? "general";
      const task = input.task ?? `review-diff-async:${focus}`;
      const started = await app.start({
        provider: codingProvider(),
        task,
        repoPath: input.repoPath,
        mode: "reviewer",
      });
      return app.turnAsync({
        sessionId: started.sessionId,
        message: reviewDiffMessage(focus),
        diff: input.diff,
        files: input.files,
        idempotencyKey: input.idempotencyKey,
        riskLevel: input.riskLevel,
        focus,
      });
    },

    /**
     * Long-running debug handoff as a background job (large logs / multi-attempt).
     */
    async debugAsync(input: {
      errorLog: string;
      repoPath: string;
      idempotencyKey: string;
      attemptedFixes?: string;
      failedAttempts?: number;
      diff?: string;
      files?: Array<{ path: string; content: string }>;
      task?: string;
      riskLevel?: RiskLevel;
    }): Promise<JobStatusResponse> {
      const task = input.task ?? "debug-async";
      const started = await app.start({
        provider: codingProvider(),
        task,
        repoPath: input.repoPath,
        mode: "critic",
      });
      return app.turnAsync({
        sessionId: started.sessionId,
        message: debugMessage({
          errorLog: input.errorLog,
          attemptedFixes: input.attemptedFixes,
        }),
        diff: input.diff,
        files: input.files,
        idempotencyKey: input.idempotencyKey,
        riskLevel: input.riskLevel ?? (input.failedAttempts && input.failedAttempts >= 2 ? "high" : "medium"),
      });
    },

    async gcJobs(input?: { maxAgeMs?: number }) {
      await hydrate();
      const maxAgeMs =
        input?.maxAgeMs ??
        parsePositiveInt(
          process.env.PEER_AGENTS_JOB_GC_MAX_AGE_MS,
          7 * 24 * 60 * 60 * 1000,
        );
      return gcTerminalJobs(jobsDir, { maxAgeMs });
    },

    async getJobStatus(input: { jobId: string }): Promise<JobStatusResponse> {
      await hydrate();
      const job = await resolveJob(input.jobId);
      return formatJobStatus(job);
    },

    async cancelJob(input: { jobId: string }): Promise<JobStatusResponse> {
      await hydrate();
      const live = liveJobs.get(input.jobId);
      const job = live?.stored ?? (await loadJobFromDir(jobsDir, input.jobId));
      if (!job) {
        throw new Error(`Unknown job: ${input.jobId}`);
      }

      if (isTerminalJobStatus(job.status)) {
        return formatJobStatus(job);
      }

      live?.abortController.abort();
      await transitionJob(job, {
        status: "cancelled",
        error: "Cancelled by caller",
      });
      return formatJobStatus(job);
    },

    async compare(input: {
      message: string;
      repoPath: string;
      task: string;
      providers?: PeerProviderName[];
      diff?: string;
      files?: Array<{ path: string; content: string }>;
      mode?: Session["mode"];
      system?: string;
      parallel?: boolean;
      idempotencyKey: string;
    }): Promise<CompareResult> {
      await hydrate();

      const replay = await loadComparisonFromDir(comparisonsDir, input.idempotencyKey);
      if (replay) {
        return replay as CompareResult;
      }

      const requested =
        input.providers && input.providers.length > 0
          ? [...new Set(input.providers)]
          : (["grok", "antigravity"] as PeerProviderName[]);
      const providersToRun = requested.filter((p) => enabledProviders.has(p));
      if (providersToRun.length === 0) {
        throw new Error(
          `No enabled providers among requested: ${requested.join(", ")}. ` +
            `Enabled: ${[...enabledProviders].join(", ") || "(none)"}.`,
        );
      }
      const mode = input.mode ?? "reviewer";
      const parallel = input.parallel ?? mode !== "implementer";
      const turnInput = {
        message: input.message,
        diff: input.diff,
        files: input.files,
      };

      const runForProvider = async (
        provider: PeerProviderName,
      ): Promise<CompareProviderResult> => {
        const started = await app.start({
          provider,
          task: input.task,
          repoPath: input.repoPath,
          mode,
          system: input.system,
        });
        const session = getSession(started.sessionId);

        return enqueue(session, async () => {
          const result = await runPeerTurn(
            session,
            turnInput,
            input.message,
          );
          return {
            provider,
            sessionId: result.sessionId,
            version: result.version,
            response: result.response,
            stateSummary: result.stateSummary,
            nativeSessionId: result.nativeSessionId,
            isError: result.isError ?? false,
          };
        });
      };

      const providerResults = parallel
        ? await Promise.all(providersToRun.map(runForProvider))
        : await providersToRun.reduce(
            async (chain, provider) => {
              const accumulated = await chain;
              accumulated.push(await runForProvider(provider));
              return accumulated;
            },
            Promise.resolve([] as CompareProviderResult[]),
          );

      const results: Partial<Record<PeerProviderName, CompareProviderResult>> = {};
      for (const entry of providerResults) {
        results[entry.provider] = entry;
      }

      const compareResult: CompareResult = {
        idempotencyKey: input.idempotencyKey,
        comparisonGroup: input.task,
        providers: providersToRun,
        parallel,
        results,
        allSucceeded: providerResults.every((entry) => !entry.isError),
        partialFailure:
          providerResults.some((entry) => entry.isError) &&
          providerResults.some((entry) => !entry.isError),
      };

      await saveComparisonToDir(comparisonsDir, input.idempotencyKey, compareResult);
      return compareResult;
    },

    async summarize(input: { sessionId: string }) {
      const session = getSession(input.sessionId);
      const unresolved = session.messages
        .filter((message) => message.role === "assistant" && /question|clarif/i.test(message.content))
        .slice(-3)
        .map((message) => message.content.slice(0, 240));

      return {
        sessionId: session.id,
        summary: session.summary ?? "",
        decisions: [],
        unresolvedIssues: unresolved,
        stateSummary: stateSummary(session),
      };
    },

    async transcript(input: { sessionId: string; maxTurns?: number; format?: "json" | "markdown" }) {
      const session = getSession(input.sessionId);
      const maxTurns = input.maxTurns ?? 20;
      const messages = session.messages.slice(-maxTurns * 2);
      if (input.format === "markdown") {
        const body = messages
          .map((message) => `**${message.participant ?? message.role}**: ${message.content}`)
          .join("\n\n");
        return { sessionId: session.id, transcript: body };
      }
      return { sessionId: session.id, transcript: messages };
    },

    async listSessions(input?: { repoPath?: string }) {
      await hydrate();
      const all = [...sessions.values()];
      const filtered = input?.repoPath
        ? all.filter((session) => session.repoPath === input.repoPath)
        : all;
      return filtered.map((session) => ({
        sessionId: session.id,
        provider: session.provider,
        task: session.task,
        repoPath: session.repoPath,
        mode: session.mode,
        version: session.version,
        updatedAt: session.updatedAt,
        stateSummary: stateSummary(session),
      }));
    },

    async reset(input: MutateInput & { keepMetadata?: boolean }) {
      const session = getSession(input.sessionId);
      return enqueue(session, async () => {
        const replay = getCommittedOperationResult(session, input.idempotencyKey);
        if (replay) return replay;

        assertExpectedVersion(session, input.expectedVersion);
        if (input.keepMetadata) {
          session.messages = [];
          session.summary = "";
          session.operations = [];
        } else {
          sessions.delete(session.id);
          await deleteSessionFromDir(storageDir, session.id);
          const result = { sessionId: session.id, deleted: true };
          return result;
        }
        session.version += 1;
        session.updatedAt = new Date().toISOString();
        await persist(session);
        const result = {
          sessionId: session.id,
          deleted: false,
          stateSummary: stateSummary(session),
        };
        commitOperation(session, input.idempotencyKey, result);
        return result;
      });
    },
  };

  return app;
}

const SECRET_PATTERNS = [
  /(?:api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[A-Za-z0-9_\-./+=]{8,}/gi,
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
];

function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

function contextQualityInputForKind(
  kind: TaskKind,
  input: {
    task: string;
    message: string;
    diff?: string;
    files?: Array<{ path: string; content: string }>;
    failedAttempts?: number;
    constraints?: string;
    repoSummary?: string;
    errorLog?: string;
    attemptedFixes?: string;
    testOutput?: string;
    question?: string;
    context?: string;
    planA?: string;
    planB?: string;
  },
): ContextQualityInput {
  switch (kind) {
    case "plan":
      return {
        kind: "plan",
        task: input.task,
        constraints: input.constraints,
        repoSummary: input.repoSummary,
        files: input.files,
      };
    case "debug":
      return {
        kind: "debug",
        errorLog: input.errorLog ?? input.message,
        attemptedFixes: input.attemptedFixes,
        failedAttempts: input.failedAttempts,
        diff: input.diff,
        files: input.files,
      };
    case "verify":
      return {
        kind: "verify",
        testOutput: input.testOutput ?? input.message,
        diff: input.diff,
        files: input.files,
      };
    case "general_knowledge":
      return {
        kind: "ask",
        question: input.question ?? input.message,
        context: input.context,
        files: input.files,
      };
    case "debate":
      return {
        kind: "debate",
        task: input.task,
        planA: input.planA,
        planB: input.planB,
      };
    default:
      return {
        kind: "review_diff",
        diff: input.diff,
        files: input.files,
        task: input.task,
      };
  }
}

function modeForKind(kind: TaskKind): Session["mode"] {
  switch (kind) {
    case "plan":
      return "planner";
    case "debug":
    case "debate":
      return "critic";
    default:
      return "reviewer";
  }
}
