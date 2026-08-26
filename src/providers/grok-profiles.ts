import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PeerComplexity, PeerFocus, PeerMode, PeerRiskLevel } from "./types.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type GrokCapabilityProfile = {
  /** CLI args after prompt-file / resume / output-format. */
  args: string[];
  /** Whether always-approve / bypass permissions is enabled. */
  alwaysApprove: boolean;
  maxTurns: number;
  /** Prefer parsing findings JSON from the model's final text when present. */
  preferParsedFindings: boolean;
};

/**
 * Map peer mode to Grok headless safety / tool constraints.
 * Review-like modes stay read-only; implementer gets autonomy.
 */
export function capabilityProfileForMode(mode: PeerMode): GrokCapabilityProfile {
  switch (mode) {
    case "implementer":
      return {
        alwaysApprove: true,
        maxTurns: 80,
        preferParsedFindings: false,
        args: [
          "--sandbox",
          "workspace",
          "--max-turns",
          "80",
          "--always-approve",
        ],
      };
    case "planner":
      return {
        alwaysApprove: true,
        maxTurns: 30,
        preferParsedFindings: false,
        args: [
          "--sandbox",
          "read-only",
          "--max-turns",
          "30",
          "--disallowed-tools",
          "search_replace,write",
          "--disable-web-search",
          "--permission-mode",
          "plan",
          "--always-approve",
          "--deny",
          "Bash(rm -rf *)",
          "--deny",
          "Bash(git push *)",
        ],
      };
    case "critic":
    case "reviewer":
    default:
      return {
        alwaysApprove: true,
        maxTurns: 25,
        preferParsedFindings: true,
        args: [
          "--sandbox",
          "read-only",
          "--max-turns",
          "25",
          "--disallowed-tools",
          "search_replace,write",
          "--disable-web-search",
          "--always-approve",
          "--no-plan",
          "--no-subagents",
          "--deny",
          "Bash(rm -rf *)",
          "--deny",
          "Bash(git push *)",
        ],
      };
  }
}

/**
 * Map risk / complexity / focus to Grok `--effort` when elevated.
 * Returns undefined to leave CLI default.
 */
export function effortForRisk(input: {
  riskLevel?: PeerRiskLevel;
  complexity?: PeerComplexity;
  focus?: PeerFocus;
  mode: PeerMode;
}): string | undefined {
  if (input.focus === "security" || input.riskLevel === "high") {
    return "high";
  }
  if (input.complexity === "complex" || input.mode === "implementer") {
    return "medium";
  }
  if (input.riskLevel === "medium") {
    return "medium";
  }
  return undefined;
}

export function shouldSelfVerify(input: {
  riskLevel?: PeerRiskLevel;
  focus?: PeerFocus;
  mode: PeerMode;
  selfVerify?: boolean;
}): boolean {
  if (input.selfVerify === true) return true;
  if (input.selfVerify === false) return false;
  if (input.mode !== "reviewer" && input.mode !== "critic") return false;
  return input.riskLevel === "high" || input.focus === "security";
}

/**
 * Resolve packaged specialist agent definition for Grok `--agent`.
 * Returns absolute path when the agent file exists.
 */
export function agentPathForFocus(input: {
  focus?: PeerFocus;
  mode: PeerMode;
  agent?: string;
}): string | undefined {
  if (input.agent?.trim()) {
    return input.agent.trim();
  }
  let relative: string | undefined;
  if (input.focus === "security") {
    relative = "agents/security-reviewer.md";
  } else if (input.focus === "architecture" || input.mode === "planner") {
    relative = "agents/architect-planner.md";
  }
  if (!relative) return undefined;
  const absolute = join(PACKAGE_ROOT, relative);
  return existsSync(absolute) ? absolute : undefined;
}
