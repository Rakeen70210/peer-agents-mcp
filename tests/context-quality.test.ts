import assert from "node:assert/strict";
import test from "node:test";

import { assessContextQuality, contextQualityHint } from "../src/context-quality.js";

test("flags thin review diff context", () => {
  const warnings = assessContextQuality({
    kind: "review_diff",
    diff: "tiny",
  });
  assert.ok(warnings.some((warning) => warning.includes("diff")));
  assert.ok(warnings.some((warning) => warning.includes("files")));
});

test("flags missing debug attempted fixes", () => {
  const warnings = assessContextQuality({
    kind: "debug",
    errorLog: "short",
    failedAttempts: 2,
  });
  assert.ok(warnings.some((warning) => warning.includes("attempted_fixes")));
});

test("returns undefined hint when context is sufficient", () => {
  const warnings = assessContextQuality({
    kind: "plan",
    task: "Migrate JWT validation to asymmetric keys across API and worker services",
    constraints: "No breaking API changes; rollout behind feature flag",
    repoSummary: "Monorepo with api/ and worker/ sharing auth middleware in packages/auth",
    files: [{ path: "packages/auth/jwt.ts", content: "export function verify() {}" }],
  });
  assert.equal(warnings.length, 0);
  assert.equal(contextQualityHint(warnings), undefined);
});

test("flags prose instead of base64 for multimodal files", () => {
  const warnings = assessContextQuality({
    kind: "review_diff",
    diff: "diff --git a/foo b/foo\n+const x = 1",
    files: [{ path: "ui/login.png", content: "Shows a clipped submit button." }],
    task: "Review mobile login layout regression on iOS Safari",
  });
  assert.ok(warnings.some((warning) => warning.includes("prose description")));
});

test("formats advisory when warnings exist", () => {
  const hint = contextQualityHint(["add full diff"]);
  assert.match(hint ?? "", /Context may be too thin/);
  assert.match(hint ?? "", /add full diff/);
});