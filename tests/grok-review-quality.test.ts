import assert from "node:assert/strict";
import test from "node:test";

import {
  extractJsonObjects,
  isIncompletePeerReview,
  lastFindingsObject,
} from "../src/providers/grok-review-quality.js";

const emptyArrays = {
  findings: [] as unknown[],
  residual_risks: [] as unknown[],
  recommended_next_steps: [] as unknown[],
};

test("live stub sentence is incomplete", () => {
  assert.equal(
    isIncompletePeerReview({
      text: "I'll inspect the full prompt, remediation plan, and current source/release contracts first…",
    }),
    true,
  );
});

test("empty findings JSON with I'll inspect is incomplete", () => {
  const structured = {
    summary: "I'll inspect the iOS runtime next",
    ...emptyArrays,
  };
  assert.equal(isIncompletePeerReview({ text: JSON.stringify(structured), structured }), true);
});

test("empty findings with no-issues summary is complete", () => {
  assert.equal(
    isIncompletePeerReview({
      text: "",
      structured: {
        summary: "No material issues; the change is limited to X in `src/foo.ts`.",
        ...emptyArrays,
      },
    }),
    false,
  );
  assert.equal(
    isIncompletePeerReview({
      text: JSON.stringify({
        summary: "No issues found.",
        ...emptyArrays,
      }),
    }),
    false,
  );
});

test("finding issue containing I'll look is complete", () => {
  assert.equal(
    isIncompletePeerReview({
      text: "",
      structured: {
        summary: "One follow-up",
        findings: [
          {
            severity: "minor",
            issue: "I'll look at error handling next",
          },
        ],
        residual_risks: [],
        recommended_next_steps: [],
      },
    }),
    false,
  );
});

test("planner prose with numbered steps is complete", () => {
  assert.equal(
    isIncompletePeerReview({
      text: "I'll start by splitting the migration into three PRs.\n\n1. Extract types\n2. Move adapters",
    }),
    false,
  );
});

test("complete prose with no JSON is complete and lastFindingsObject is undefined", () => {
  const text = "No material issues; the change is limited to X in `src/foo.ts`.";
  assert.equal(isIncompletePeerReview({ text }), false);
  assert.equal(lastFindingsObject(text), undefined);
});

test("concatenated stub then real findings uses the last object", () => {
  const stub = {
    summary: "I'll finish the remaining source checks...",
    findings: [],
    residual_risks: [],
    recommended_next_steps: [],
  };
  const real = {
    summary: "The follow-on defect plan correctly names the issue",
    findings: [{ severity: "major", issue: 'use { foo: 1 } instead of bar' }],
    residual_risks: [],
    recommended_next_steps: ["Add a unit test"],
  };
  const text = `${JSON.stringify(stub)}\n${JSON.stringify(real)}`;
  assert.equal(isIncompletePeerReview({ text }), false);
  assert.deepEqual(lastFindingsObject(text), real);
});

test("brace scanner keeps { inside an issue string", () => {
  const obj = {
    summary: "Found issues",
    findings: [{ severity: "minor", issue: "use { foo: 1 } instead of bar" }],
    residual_risks: [],
    recommended_next_steps: [],
  };
  const parsed = extractJsonObjects(JSON.stringify(obj));
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], obj);
  assert.deepEqual(lastFindingsObject(JSON.stringify(obj))?.findings?.[0], obj.findings[0]);
});

test("empty unstructured text is incomplete", () => {
  assert.equal(isIncompletePeerReview({ text: "   " }), true);
});
