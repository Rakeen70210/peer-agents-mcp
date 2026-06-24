import { classifyAttachments } from "./attachments.js";
import type { TaskKind } from "./router.js";

export function buildTaskPrompt(input: {
  kind: TaskKind;
  message: string;
  diff?: string;
  files?: Array<{ path: string; content: string }>;
  independentReview?: boolean;
}): string {
  const preamble = input.independentReview
    ? [
        "Provide your own independent analysis.",
        "Do not assume you have seen another model's answer.",
        "Be explicit about risks, unknowns, and recommended next steps.",
      ]
    : [
        "You may edit files and run commands in the repo when that helps.",
        "Be direct and actionable.",
      ];

  const lines = [...preamble, "", input.message.trim()];

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

  return lines.join("\n");
}

export function reviewDiffMessage(focus: string): string {
  return `Review this diff with primary focus on ${focus}. List concrete issues, regressions, and missing tests.`;
}

export function planMessage(input: {
  task: string;
  constraints?: string;
  repoSummary?: string;
}): string {
  const lines = [
    "Create an implementation plan for the task below.",
    "Return ordered steps, risks, and verification checkpoints.",
    "",
    `Task: ${input.task.trim()}`,
  ];
  if (input.constraints?.trim()) {
    lines.push("", "Constraints:", input.constraints.trim());
  }
  if (input.repoSummary?.trim()) {
    lines.push("", "Repo summary:", input.repoSummary.trim());
  }
  return lines.join("\n");
}

export function debugMessage(input: {
  errorLog: string;
  attemptedFixes?: string;
}): string {
  const lines = [
    "Diagnose the failure and propose the smallest fix that addresses the root cause.",
    "",
    "Error log:",
    input.errorLog.trim(),
  ];
  if (input.attemptedFixes?.trim()) {
    lines.push("", "Attempted fixes:", input.attemptedFixes.trim());
  }
  return lines.join("\n");
}

export function verifyMessage(input: { testOutput: string }): string {
  return [
    "Verify whether the change is safe to proceed.",
    "Assess test failures, missing coverage, and regressions.",
    "",
    "Test output:",
    input.testOutput.trim(),
  ].join("\n");
}

export function askMessage(input: { question: string; context?: string }): string {
  const lines = [
    "Answer the question below. Use repo context only when it helps.",
    "Prefer grounded, factual answers. Say when you are uncertain.",
    "",
    input.question.trim(),
  ];
  if (input.context?.trim()) {
    lines.push("", "Context:", input.context.trim());
  }
  return lines.join("\n");
}

export function debateMessage(input: {
  task: string;
  planA: string;
  planB: string;
}): string {
  return [
    "Compare Plan A and Plan B independently for the task below.",
    "Do not favor one plan by default.",
    "Return: strengths, weaknesses, risks, and which plan you would choose with rationale.",
    "",
    `Task: ${input.task.trim()}`,
    "",
    "Plan A:",
    input.planA.trim(),
    "",
    "Plan B:",
    input.planB.trim(),
  ].join("\n");
}

export function synthesisHint(routeCount: number): string {
  if (routeCount <= 1) {
    return "Single peer response returned. Apply judgment and patch locally as needed.";
  }
  return [
    "Multiple independent peer responses returned.",
    "Synthesize by answering:",
    "1) Where do all peers agree?",
    "2) Where do they disagree?",
    "3) Which objections are actionable vs speculative?",
    "4) What patch should be applied next?",
  ].join(" ");
}