import {
  hasMultimodalExtension,
  isBinaryAttachment,
  isValidBinaryContent,
} from "./attachments.js";

export type ContextQualityInput = {
  kind:
    | "review_diff"
    | "plan"
    | "debug"
    | "verify"
    | "ask"
    | "debate"
    | "turn"
    | "compare";
  diff?: string;
  files?: Array<{ path: string; content: string }>;
  task?: string;
  constraints?: string;
  repoSummary?: string;
  errorLog?: string;
  attemptedFixes?: string;
  failedAttempts?: number;
  testOutput?: string;
  question?: string;
  context?: string;
  planA?: string;
  planB?: string;
  message?: string;
};

const MIN_DIFF_CHARS = 80;
const MIN_ERROR_LOG_CHARS = 120;
const MIN_TASK_CHARS = 40;
const MIN_PLAN_CHARS = 80;
const MIN_QUESTION_CHARS = 30;

function trimmedLength(value?: string): number {
  return value?.trim().length ?? 0;
}

function assessMultimodalFiles(
  files?: Array<{ path: string; content: string }>,
): string[] {
  if (!files?.length) {
    return [];
  }

  const warnings: string[] = [];
  for (const file of files) {
    if (!hasMultimodalExtension(file.path) && !isBinaryAttachment(file.path, file.content)) {
      continue;
    }

    const content = file.content.trim();
    if (content.length < 100 && !content.startsWith("data:")) {
      warnings.push(
        `\`${file.path}\` looks like a prose description — pass base64 or a data-URI for binary attachments.`,
      );
      continue;
    }

    if (!isValidBinaryContent(content)) {
      warnings.push(
        `\`${file.path}\` has a binary extension but content is not valid base64/data-URI.`,
      );
    }
  }

  return warnings;
}

export function assessContextQuality(input: ContextQualityInput): string[] {
  const warnings: string[] = [...assessMultimodalFiles(input.files)];

  switch (input.kind) {
    case "review_diff": {
      const diffLen = trimmedLength(input.diff);
      if (diffLen < MIN_DIFF_CHARS) {
        warnings.push(
          "diff is very short — pass the full `git diff` (or patch), not a summary.",
        );
      }
      if (!input.files?.length) {
        warnings.push(
          "no `files` attached — include full contents of changed and closely related source files.",
        );
      }
      if (!input.task?.trim()) {
        warnings.push(
          "set `task` with the change goal, affected behavior, and specific review concerns.",
        );
      }
      break;
    }
    case "plan": {
      if (trimmedLength(input.task) < MIN_TASK_CHARS) {
        warnings.push(
          "task is brief — describe the goal, success criteria, and affected areas in `task`.",
        );
      }
      if (!input.constraints?.trim()) {
        warnings.push(
          "add `constraints` (API compatibility, deadlines, tech limits, out-of-scope items).",
        );
      }
      if (!input.repoSummary?.trim() && !input.files?.length) {
        warnings.push(
          "add `repo_summary` or attach key `files` so the peer understands existing architecture.",
        );
      }
      break;
    }
    case "debug": {
      if (trimmedLength(input.errorLog) < MIN_ERROR_LOG_CHARS) {
        warnings.push(
          "error_log is short — include full stderr, stack trace, and failing test output.",
        );
      }
      if ((input.failedAttempts ?? 0) > 0 && !input.attemptedFixes?.trim()) {
        warnings.push(
          "failed_attempts > 0 but `attempted_fixes` is empty — list what you already tried.",
        );
      }
      if (!input.diff?.trim() && !input.files?.length) {
        warnings.push(
          "attach current `diff` or relevant `files` so the peer can see your in-progress fix.",
        );
      }
      break;
    }
    case "verify": {
      if (!input.testOutput?.trim()) {
        warnings.push("test_output is required and should include the full runner output.");
      }
      if (!input.diff?.trim() && !input.files?.length) {
        warnings.push(
          "attach the `diff` or changed `files` under verification — output alone is often insufficient.",
        );
      }
      break;
    }
    case "ask": {
      if (trimmedLength(input.question) < MIN_QUESTION_CHARS) {
        warnings.push(
          "question is brief — state the decision, constraints, and what a good answer must cover.",
        );
      }
      if (!input.context?.trim() && !input.files?.length) {
        warnings.push(
          "add `context` or attach `files` with repo-specific background the peer needs.",
        );
      }
      break;
    }
    case "debate": {
      if (trimmedLength(input.task) < MIN_TASK_CHARS) {
        warnings.push("task should explain what decision the debate must resolve.");
      }
      if (trimmedLength(input.planA) < MIN_PLAN_CHARS) {
        warnings.push("plan_a is thin — include concrete steps, tradeoffs, and risks.");
      }
      if (trimmedLength(input.planB) < MIN_PLAN_CHARS) {
        warnings.push("plan_b is thin — include concrete steps, tradeoffs, and risks.");
      }
      break;
    }
    case "turn": {
      if (!input.message?.trim()) {
        warnings.push("message must describe what changed since the last turn.");
      }
      if (!input.diff?.trim() && !input.files?.length) {
        warnings.push(
          "attach updated `diff` or `files` when asking for re-review or regression checks.",
        );
      }
      break;
    }
    case "compare": {
      if (!input.message?.trim()) {
        warnings.push("message should state the exact question both peers must answer.");
      }
      if (!input.diff?.trim() && !input.files?.length) {
        warnings.push("attach `diff` or `files` when the prompt depends on code context.");
      }
      break;
    }
  }

  return warnings;
}

export function contextQualityHint(warnings: string[]): string | undefined {
  if (warnings.length === 0) return undefined;
  return [
    "Context may be too thin for a high-quality peer response.",
    "Gather more detail before retrying:",
    ...warnings.map((warning) => `- ${warning}`),
  ].join("\n");
}