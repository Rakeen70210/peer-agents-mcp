import assert from "node:assert/strict";
import test from "node:test";

import { formatGoDuration } from "../src/providers/runner.js";

test("formatGoDuration uses minutes for whole-minute timeouts", () => {
  assert.equal(formatGoDuration(300_000), "5m");
  assert.equal(formatGoDuration(120_000), "2m");
});

test("formatGoDuration uses seconds for sub-minute timeouts", () => {
  assert.equal(formatGoDuration(90_000), "90s");
  assert.equal(formatGoDuration(1_500), "2s");
});