import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveEnabledProviders,
  routePeerTask,
} from "../src/router.js";

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

test("when Grok is disabled, coding tasks fall back to Antigravity", () => {
  const decision = routePeerTask({
    kind: "review_diff",
    enabledProviders: new Set(["antigravity"]),
  });
  assert.deepEqual(decision.routes, ["antigravity"]);
  assert.ok(
    decision.rationale.some((line) => line.includes("falling back")),
  );
});

test("resolveEnabledProviders supports whitelist and blacklist env", () => {
  assert.deepEqual(
    [...resolveEnabledProviders({ env: { PEER_AGENTS_ENABLED_PROVIDERS: "antigravity" } })],
    ["antigravity"],
  );
  assert.deepEqual(
    [...resolveEnabledProviders({ env: { PEER_AGENTS_DISABLED_PROVIDERS: "grok" } })].sort(),
    ["antigravity"],
  );
  assert.deepEqual(
    [...resolveEnabledProviders({ env: {} })].sort(),
    ["antigravity", "grok"],
  );
});