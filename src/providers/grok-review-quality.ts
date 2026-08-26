export type FindingsLike = {
  summary?: string;
  findings?: unknown[];
  residual_risks?: unknown[];
  recommended_next_steps?: unknown[];
};

/** Anchored at start so mid-review “I’ll look…” does not match. */
const INTENT_RE =
  /^(?:i['’]?ll|i will|let me|i am going to|i['’]m going to)\b[\s\S]{0,80}?\b(inspect|review|start|look|read|check|locate|pull|finish|begin)\b/i;

const FILE_CITE_RE = /(?:[A-Za-z0-9_./-]+\.[A-Za-z0-9]+|`[^`]+\.[A-Za-z0-9]+`)/;
const PLAN_STRUCTURE_RE = /(?:^|\n)\s*(?:\d+\.|#{1,3}\s|[-*]\s)/;

export const CONTINUATION_PROMPT =
  "Do not narrate setup or say what you intend to inspect. Use tools (read_file, grep, list_dir) against the repo now, then return the finished review. Prefer a single JSON object with keys summary, findings, residual_risks, recommended_next_steps. Prose is acceptable. Do not concatenate JSON objects.";

export function isIncompletePeerReview(input: {
  text: string;
  structured?: unknown;
}): boolean {
  const structured = asFindings(input.structured) ?? lastFindingsObject(input.text);
  if (structured) {
    const empty =
      emptyArr(structured.findings) &&
      emptyArr(structured.residual_risks) &&
      emptyArr(structured.recommended_next_steps);
    if (!empty) return false;
    return INTENT_RE.test(
      typeof structured.summary === "string" ? structured.summary.trim() : "",
    );
  }
  const text = input.text.trim();
  if (!text) return true;
  if (!INTENT_RE.test(text)) return false;
  if (FILE_CITE_RE.test(text) || PLAN_STRUCTURE_RE.test(text)) return false;
  return text.length < 500;
}

export function extractJsonObjects(text: string): unknown[] {
  const source = unwrapSingleFence(text);
  const objects: unknown[] = [];
  let index = 0;
  while (index < source.length) {
    if (source[index] !== "{") {
      index += 1;
      continue;
    }
    const end = scanObjectEnd(source, index);
    if (end < 0) break;
    try {
      objects.push(JSON.parse(source.slice(index, end)));
    } catch {
      // Skip slices that are not valid JSON (truncated or prose braces).
    }
    index = end;
  }
  return objects;
}

export function lastFindingsObject(text: string): FindingsLike | undefined {
  const findings = extractJsonObjects(text).filter(isFindingsShape);
  const withIssues = findings.filter((object) => (object.findings?.length ?? 0) > 0);
  return withIssues.at(-1) ?? findings.at(-1);
}

function asFindings(value: unknown): FindingsLike | undefined {
  return isFindingsShape(value) ? value : undefined;
}

function isFindingsShape(value: unknown): value is FindingsLike {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (
    Object.prototype.hasOwnProperty.call(value, "summary") &&
    Object.prototype.hasOwnProperty.call(value, "findings")
  );
}

function emptyArr(value: unknown): boolean {
  return !Array.isArray(value) || value.length === 0;
}

function unwrapSingleFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  return fenced?.[1] ?? text;
}

function scanObjectEnd(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}
