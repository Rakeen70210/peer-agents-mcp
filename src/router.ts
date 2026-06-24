import { hasMultimodalExtension, isBinaryAttachment } from "./attachments.js";
import type { RoutedProvider } from "./catalog.js";

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
};

export type RouteDecision = {
  routes: RoutedProvider[];
  parallel: boolean;
  rationale: string[];
};

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

export function routePeerTask(input: RouteInput): RouteDecision {
  const rationale: string[] = [];

  if (input.hasImagesOrPdf || input.kind === "ui_multimodal") {
    rationale.push("Multimodal input → Antigravity");
    return { routes: ["antigravity"], parallel: true, rationale };
  }

  if (
    input.kind === "large_context" ||
    input.kind === "general_knowledge" ||
    (input.contextTokensEstimate ?? 0) > LARGE_CONTEXT_THRESHOLD
  ) {
    rationale.push("Large context or general knowledge → Antigravity");
    return { routes: ["antigravity"], parallel: true, rationale };
  }

  if (CODING_TASK_KINDS.has(input.kind)) {
    rationale.push("Coding task → Grok");
    return { routes: ["grok"], parallel: true, rationale };
  }

  rationale.push("Default → Grok");
  return { routes: ["grok"], parallel: true, rationale };
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