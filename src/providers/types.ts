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
   * When true (or a string name), start Grok in a new git worktree.
   * String value is the worktree name; true derives a name from context.
   */
  worktree?: boolean | string;
  /**
   * Request structured JSON findings (Grok `--json-schema`).
   * Default: true for reviewer/critic when not resuming implementer work.
   */
  structuredOutput?: boolean;
  /** Append Grok self-verification loop (`--check`). */
  selfVerify?: boolean;
  /**
   * Use streaming-json and report progress (async jobs).
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
  /** Parsed structured findings when `--json-schema` was used. */
  structured?: unknown;
  /** Worktree name passed to Grok when isolation was requested. */
  worktreeName?: string;
  /** Last progress snapshot when streamProgress was enabled. */
  progress?: PeerRunProgress;
};

export interface PeerProvider {
  readonly name: PeerProviderName;
  healthCheck(): Promise<{ ok: boolean; latencyMs: number; detail?: string }>;
  runTurn(input: PeerRunInput): Promise<PeerRunResult>;
}
