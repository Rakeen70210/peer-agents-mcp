import assert from "node:assert/strict";
import test from "node:test";

import { routePeerTask } from "../src/router.js";

test("routes coding tasks to Grok", () => {
  assert.deepEqual(routePeerTask({ kind: "review_diff" }).routes, ["grok"]);
  assert.deepEqual(routePeerTask({ kind: "plan", complexity: "complex" }).routes, ["grok"]);
  assert.deepEqual(routePeerTask({ kind: "debug", failedAttempts: 3 }).routes, ["grok"]);
  assert.deepEqual(routePeerTask({ kind: "security", risk: "high" }).routes, ["grok"]);
  assert.deepEqual(routePeerTask({ kind: "debate" }).routes, ["grok"]);
});

test("routes large context to Antigravity", () => {
  const decision = routePeerTask({
    kind: "review_diff",
    contextTokensEstimate: 200_000,
  });
  assert.deepEqual(decision.routes, ["antigravity"]);
});

test("routes general knowledge to Antigravity", () => {
  const decision = routePeerTask({ kind: "general_knowledge" });
  assert.deepEqual(decision.routes, ["antigravity"]);
});

test("routes multimodal to Antigravity even for coding kind", () => {
  const decision = routePeerTask({
    kind: "review_diff",
    hasImagesOrPdf: true,
  });
  assert.deepEqual(decision.routes, ["antigravity"]);
});