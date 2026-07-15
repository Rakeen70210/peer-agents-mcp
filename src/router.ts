import { hasMultimodalExtension, isBinaryAttachment } from "./attachments.js";
import type { RoutedProvider } from "./catalog.js";
import type { PeerProviderName } from "./providers/types.js";

export type TaskKind =
  | "plan"
  | "review_diff"
  | "debug"
  | "test_generation"
  | "verify"
  | "architecture"
  | "security"
  | "ui_multimodal"
  | "large_context"
  | "final_review"
  | "debate"
  | "general_knowledge";

export type RiskLevel = "low" | "medium" | "high";

export type RouteInput = {
  kind: TaskKind;
  risk?: RiskLevel;
  contextTokensEstimate?: number;
  hasImagesOrPdf?: boolean;
  failedAttempts?: number;
  needsSpeed?: boolean;
  needsDeepReasoning?: boolean;
  complexity?: "simple" | "complex";
  focus?: "bugs" | "architecture" | "security" | "tests" | "general";
  /** When set, preferred routes outside this set are remapped to enabled peers. */
  enabledProviders?: ReadonlySet<PeerProviderName>;
};

export type RouteDecision = {
  routes: RoutedProvider[];
  parallel: boolean;
  rationale: string[];
};

const ALL_PROVIDERS: PeerProviderName[] = ["grok", "antigravity"];
const LARGE_CONTEXT_THRESHOLD = 150_000;

const CODING_TASK_KINDS = new Set<TaskKind>([
  "plan",
  "review_diff",
  "debug",
  "test_generation",
  "verify",
  "architecture",
  "security",
  "final_review",
  "debate",
]);

function parseProviderList(raw: string | undefined): PeerProviderName[] {
  if (!raw?.trim()) return [];
  const out: PeerProviderName[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const name = part.trim().toLowerCase();
    if (name === "grok" || name === "antigravity") {
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

/**
 * Resolve which peer CLIs are active for this server process.
 *
 * - `PEER_AGENTS_ENABLED_PROVIDERS=antigravity` — whitelist (use when host is Grok)
 * - `PEER_AGENTS_DISABLED_PROVIDERS=grok` — blacklist
 * - Enabled list wins if both are set
 */
export function resolveEnabledProviders(options?: {
  enabledProviders?: PeerProviderName[];
  disabledProviders?: PeerProviderName[];
  env?: NodeJS.ProcessEnv;
}): Set<PeerProviderName> {
  const env = options?.env ?? process.env;
  const fromEnabledOpt = options?.enabledProviders;
  const fromEnabledEnv = parseProviderList(env.PEER_AGENTS_ENABLED_PROVIDERS);
  const enabledList =
    fromEnabledOpt && fromEnabledOpt.length > 0
      ? fromEnabledOpt
      : fromEnabledEnv.length > 0
        ? fromEnabledEnv
        : null;

  if (enabledList) {
    return new Set(enabledList);
  }

  const disabled = new Set<PeerProviderName>([
    ...(options?.disabledProviders ?? []),
    ...parseProviderList(env.PEER_AGENTS_DISABLED_PROVIDERS),
  ]);
  return new Set(ALL_PROVIDERS.filter((p) => !disabled.has(p)));
}

/** Remap preferred routes onto the enabled provider set (fallback when preferred is off). */
export function applyEnabledProviders(
  decision: RouteDecision,
  enabled: ReadonlySet<PeerProviderName>,
): RouteDecision {
  if (enabled.size === 0) {
    throw new Error(
      "No peer providers enabled. Set PEER_AGENTS_ENABLED_PROVIDERS or clear PEER_AGENTS_DISABLED_PROVIDERS.",
    );
  }

  const filtered = decision.routes.filter((route) => enabled.has(route));
  if (filtered.length > 0) {
    return { ...decision, routes: filtered };
  }

  const fallback = ALL_PROVIDERS.filter((p) => enabled.has(p)) as RoutedProvider[];
  return {
    routes: fallback,
    parallel: decision.parallel,
    rationale: [
      ...decision.rationale,
      `Preferred route unavailable (disabled); falling back to ${fallback.join(", ")}`,
    ],
  };
}

export function routePeerTask(input: RouteInput): RouteDecision {
  const rationale: string[] = [];

  let decision: RouteDecision;
  if (input.hasImagesOrPdf || input.kind === "ui_multimodal") {
    rationale.push("Multimodal input → Antigravity");
    decision = { routes: ["antigravity"], parallel: true, rationale };
  } else if (
    input.kind === "large_context" ||
    input.kind === "general_knowledge" ||
    (input.contextTokensEstimate ?? 0) > LARGE_CONTEXT_THRESHOLD
  ) {
    rationale.push("Large context or general knowledge → Antigravity");
    decision = { routes: ["antigravity"], parallel: true, rationale };
  } else if (CODING_TASK_KINDS.has(input.kind)) {
    rationale.push("Coding task → Grok");
    decision = { routes: ["grok"], parallel: true, rationale };
  } else {
    rationale.push("Default → Grok");
    decision = { routes: ["grok"], parallel: true, rationale };
  }

  if (input.enabledProviders) {
    return applyEnabledProviders(decision, input.enabledProviders);
  }
  return decision;
}

export function estimateContextTokens(parts: Array<string | undefined>): number {
  const text = parts.filter(Boolean).join("\n");
  return Math.ceil(text.length / 4);
}

export function hasMultimodalAttachments(
  files?: Array<{ path: string; content: string }>,
): boolean {
  if (!files?.length) return false;
  return files.some(
    (file) =>
      hasMultimodalExtension(file.path) ||
      isBinaryAttachment(file.path, file.content),
  );
}