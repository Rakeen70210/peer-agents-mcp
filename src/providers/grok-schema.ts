/**
 * JSON Schema for structured peer review / debug / verify findings.
 * Grok headless does not pass `--json-schema` (it aborts the tool loop on 1.0.5);
 * this shape is the preferred last-object parse target and Agy `--json-schema`.
 */
export const PEER_FINDINGS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings", "residual_risks", "recommended_next_steps"],
  properties: {
    summary: {
      type: "string",
      description: "One-paragraph overall assessment.",
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "issue"],
        properties: {
          severity: {
            type: "string",
            enum: ["blocker", "major", "minor", "nit"],
          },
          file: {
            type: "string",
            description: "Repo-relative path when applicable.",
          },
          issue: {
            type: "string",
            description: "What is wrong or risky.",
          },
          suggestion: {
            type: "string",
            description: "Concrete fix or verification step.",
          },
        },
      },
    },
    residual_risks: {
      type: "array",
      items: { type: "string" },
    },
    recommended_next_steps: {
      type: "array",
      items: { type: "string" },
    },
  },
} as const;

export function formatStructuredAsText(structured: unknown): string {
  if (!structured || typeof structured !== "object") {
    return "";
  }
  const obj = structured as {
    summary?: string;
    findings?: Array<{
      severity?: string;
      file?: string;
      issue?: string;
      suggestion?: string;
    }>;
    residual_risks?: string[];
    recommended_next_steps?: string[];
  };

  const lines: string[] = [];
  if (obj.summary?.trim()) {
    lines.push(obj.summary.trim(), "");
  }
  if (obj.findings?.length) {
    lines.push("Findings:");
    for (const finding of obj.findings) {
      const sev = finding.severity ?? "unknown";
      const loc = finding.file ? ` (${finding.file})` : "";
      lines.push(`- [${sev}]${loc} ${finding.issue ?? ""}`.trimEnd());
      if (finding.suggestion?.trim()) {
        lines.push(`  Suggestion: ${finding.suggestion.trim()}`);
      }
    }
    lines.push("");
  }
  if (obj.residual_risks?.length) {
    lines.push("Residual risks:");
    for (const risk of obj.residual_risks) {
      lines.push(`- ${risk}`);
    }
    lines.push("");
  }
  if (obj.recommended_next_steps?.length) {
    lines.push("Recommended next steps:");
    for (const step of obj.recommended_next_steps) {
      lines.push(`- ${step}`);
    }
  }
  return lines.join("\n").trim();
}
