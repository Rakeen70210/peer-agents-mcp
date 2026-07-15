import type { PeerMode } from "./types.js";

export type AntigravityCapabilityProfile = {
  /** CLI args after print / timeout / skip-permissions. */
  args: string[];
};

/**
 * Map peer mode to Antigravity headless safety / execution flags.
 * All headless turns still use `--dangerously-skip-permissions` (set by the provider).
 */
export function capabilityProfileForMode(
  mode: PeerMode,
): AntigravityCapabilityProfile {
  switch (mode) {
    case "implementer":
      return {
        args: ["--mode", "accept-edits"],
      };
    case "planner":
      return {
        args: ["--sandbox", "--mode", "plan"],
      };
    case "critic":
    case "reviewer":
    default:
      return {
        args: ["--sandbox"],
      };
  }
}
