export type PeerProviderName = "grok" | "antigravity";

export type PeerMode = "reviewer" | "planner" | "critic" | "implementer";

export type PeerFileAttachment = {
  path: string;
  content: string;
};

export type PeerRiskLevel = "low" | "medium" | "high";

export type PeerComplexity = "simple" | "complex";

export type PeerFocus =
  | "bugs"
  | "architecture"
  | "security"
  | "tests"
  | "general";

/** Spend / turn metrics from headless JSON when available. */
export type PeerRunMetrics = {
  stopReason?: string;
  numTurns?: number;
  usage?: {
    inputTokens?: number;
    cacheReadInputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  };
  totalCostUsd?: number;
  costIsPartial?: boolean;
  usageIsIncomplete?: boolean;
  modelUsage?: Record<string, unknown>;
};

export type PeerRunInput = {
  constructedPrompt: string;
  cwd?: string;
  mode: PeerMode;
  model?: string;
  files?: PeerFileAttachment[];
  /** Per-call timeout override (sync default or long-running job timeout). */
  timeoutMs?: number;
  /** AbortSignal for cancellation; terminates the provider child process. */
  signal?: AbortSignal;
  /**
   * Native CLI session id from a prior turn.
   * Grok uses this with `--resume`; Antigravity with `--conversation`.
   * When set, the prompt should be the current request only (history lives in CLI).
   */
  nativeSessionId?: string;
  /** Risk level — may raise reasoning effort for Grok. */
  riskLevel?: PeerRiskLevel;
  complexity?: PeerComplexity;
  focus?: PeerFocus;
  /**
   * When true (or a string name), isolate Grok in a git worktree via `--cwd`
   * (Grok 1.0 headless ignores `--worktree`). String value is the worktree name.
   */
  worktree?: boolean | string;
  /**
   * Prefer parsing findings JSON from the model's final text when present.
   * Grok headless does not pass `--json-schema` (that flag aborts the tool loop on 1.0.5).
   * Default: true for reviewer/critic.
   */
  structuredOutput?: boolean;
  /** Extra self-verify instruction in `--rules` (Grok `--check` was removed in 1.0). */
  selfVerify?: boolean;
  /**
   * Use Grok `streaming-json` / agy `stream-json` and report progress (async jobs).
   * Final result still aggregates full text + end-event metadata.
   */
  streamProgress?: boolean;
  /** Progress callback for streaming turns (throttled by caller if needed). */
  onProgress?: (progress: PeerRunProgress) => void;
  /** Absolute path or name for provider `--agent` (Grok / Antigravity). */
  agent?: string;
};

/** Live progress snapshot during a streaming provider turn. */
export type PeerRunProgress = {
  updatedAt: string;
  eventCount: number;
  textSnippet?: string;
  lastThought?: string;
  numTurns?: number;
  stopReason?: string;
};

export type PeerRunResult = {
  isError: boolean;
  text: string;
  stdout: string;
  stderr: string;
  nativeSessionId?: string;
  timedOut?: boolean;
  cancelled?: boolean;
  /** True when this turn resumed a native CLI session. */
  resumed?: boolean;
  metrics?: PeerRunMetrics;
  /** Parsed structured findings when a findings JSON object is present in the text. */
  structured?: unknown;
  /** Worktree name passed to Grok when isolation was requested. */
  worktreeName?: string;
  /** Last progress snapshot when streamProgress was enabled. */
  progress?: PeerRunProgress;
  /** True when the turn ended as an intent-only stub rather than a finished review. */
  incompleteReview?: boolean;
  /** How the host should continue after timeout or an incomplete stub. */
  continuationHint?: string;
  /** True when the app truncated the constructed prompt before spawn. */
  truncatedPrompt?: boolean;
};

export interface PeerProvider {
  readonly name: PeerProviderName;
  healthCheck(): Promise<{ ok: boolean; latencyMs: number; detail?: string }>;
  runTurn(input: PeerRunInput): Promise<PeerRunResult>;
}
