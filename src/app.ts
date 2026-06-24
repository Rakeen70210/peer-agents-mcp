import { basename } from "node:path";

import { classifyAttachments } from "./attachments.js";
import { resolveRouteSpec, type RoutedProvider } from "./catalog.js";
import {
  assessContextQuality,
  contextQualityHint,
  type ContextQualityInput,
} from "./context-quality.js";
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
import { GrokHeadlessProvider } from "./providers/grok-headless.js";
import type { PeerProvider, PeerProviderName, PeerRunResult } from "./providers/types.js";
import { parsePositiveInt } from "./providers/runner.js";
import {
  estimateContextTokens,
  hasMultimodalAttachments,
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
  providers?: Partial<Record<PeerProviderName, PeerProvider>>;
  maxPromptChars?: number;
  recentTurnCount?: number;
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

export function createApp(options: AppOptions = {}) {
  const storageDir = options.storageDir ?? defaultStorageDir();
  const comparisonsDir =
    options.comparisonsDir ?? comparisonsDirFor(storageDir);
  const maxPromptChars =
    options.maxPromptChars ??
    parsePositiveInt(process.env.PEER_AGENTS_MAX_PROMPT_CHARS, 120_000);
  const recentTurnCount = options.recentTurnCount ?? 8;

  const providers: Record<PeerProviderName, PeerProvider> = {
    grok: options.providers?.grok ?? new GrokHeadlessProvider(),
    antigravity:
      options.providers?.antigravity ?? new AntigravityHeadlessProvider(),
  };

  const sessions = new Map<string, Session>();

  async function hydrate(): Promise<void> {
    const loaded = await loadAllSessionsFromDir(storageDir);
    for (const session of loaded) {
      sessions.set(session.id, session);
    }
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

  function buildPrompt(session: Session, input: {
    message: string;
    diff?: string;
    files?: Array<{ path: string; content: string }>;
  }): string {
    const lines = [
      `You are ${session.routedProvider ?? session.provider} acting as a peer agent (CLI default model).`,
      MODE_INSTRUCTIONS[session.mode] ?? MODE_INSTRUCTIONS.reviewer,
      "You may edit files and run commands in the repo when that helps complete the task.",
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

  async function runPeerTurn(
    session: Session,
    prompt: string,
    userMessageForTranscript: string,
    files?: Array<{ path: string; content: string }>,
  ): Promise<TurnResult> {
    const provider = getProvider(session.provider);
    const constructedPrompt = enforcePromptLimit(prompt);
    const peerResult = await provider.runTurn({
      constructedPrompt,
      cwd: session.repoPath,
      mode: session.mode,
      files,
    });

    if (!peerResult.isError) {
      await recordTurn(session, userMessageForTranscript, peerResult);
    }

    return {
      sessionId: session.id,
      version: session.version,
      response: peerResult.text,
      stateSummary: stateSummary(session),
      nativeSessionId: peerResult.nativeSessionId ?? session.nativeSessionId ?? undefined,
      isError: peerResult.isError ?? false,
    };
  }

  function enforcePromptLimit(prompt: string): string {
    if (prompt.length <= maxPromptChars) return prompt;
    const marker = "\n\n[TRUNCATED: prompt exceeded PEER_AGENTS_MAX_PROMPT_CHARS]\n";
    return prompt.slice(0, maxPromptChars - marker.length) + marker;
  }

  return {
    hydrate,
    async health() {
      const results = await Promise.all(
        (Object.keys(providers) as PeerProviderName[]).map(async (name) => {
          const result = await providers[name].healthCheck();
          return { provider: name, ...result };
        }),
      );
      return { providers: results };
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
    }) {
      await hydrate();
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
        sessions.set(id, existing);
        return {
          sessionId: id,
          resumed: true,
          stateSummary: stateSummary(existing),
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
      });
      sessions.set(id, session);
      await persist(session);
      return {
        sessionId: id,
        resumed: false,
        stateSummary: stateSummary(session),
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
        const started = await this.start({
          provider: spec.cli,
          routedProvider: route,
          task: input.task,
          repoPath: input.repoPath,
          mode: input.mode ?? modeForKind(input.kind),
        });
        const session = getSession(started.sessionId);
        return enqueue(session, async () => {
          const prompt = buildPrompt(session, {
            message: promptMessage,
            diff: input.diff,
            files: input.files,
          });
          const result = await runPeerTurn(
            session,
            prompt,
            input.message,
            input.files,
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
      return this.executeRouted({
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
      return this.executeRouted({
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
      return this.executeRouted({
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
      return this.executeRouted({
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
      return this.executeRouted({
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
      return this.executeRouted({
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
        const prompt = buildPrompt(session, input);
        const result = await runPeerTurn(
          session,
          prompt,
          input.message,
          input.files,
        );
        commitOperation(session, input.idempotencyKey, result);
        await persist(session);
        return result;
      });
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

      const providersToRun =
        input.providers && input.providers.length > 0
          ? [...new Set(input.providers)]
          : (["grok", "antigravity"] as PeerProviderName[]);
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
        const started = await this.start({
          provider,
          task: input.task,
          repoPath: input.repoPath,
          mode,
          system: input.system,
        });
        const session = getSession(started.sessionId);

        return enqueue(session, async () => {
          const prompt = buildPrompt(session, turnInput);
          const result = await runPeerTurn(
            session,
            prompt,
            input.message,
            input.files,
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