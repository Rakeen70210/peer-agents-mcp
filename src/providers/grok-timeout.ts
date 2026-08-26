import { parsePositiveInt } from "./runner.js";

export const DEFAULT_GROK_TURN_TIMEOUT_MS = 360_000; // 6 minutes
export const AUTO_CONTINUE_FLOOR_MS = 30_000;
export const HEALTH_TURN_TIMEOUT_MS = 15_000;

/** Grok sync timeout. Does NOT read PEER_AGENTS_TURN_TIMEOUT_MS. */
export function grokTurnTimeoutMs(override?: number): number {
  if (override && override > 0) return override;
  return parsePositiveInt(
    process.env.GROK_TURN_TIMEOUT_MS,
    DEFAULT_GROK_TURN_TIMEOUT_MS,
  );
}

/** Between-turns backstop only. Must not bound an in-flight session/prompt. */
export function grokAcpIdleTimeoutMs(): number {
  const configured = parsePositiveInt(
    process.env.PEER_AGENTS_GROK_ACP_IDLE_MS,
    5 * 60_000,
  );
  return Math.max(configured, grokTurnTimeoutMs() + 60_000);
}
