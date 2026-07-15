import { GrokAcpProvider } from "./grok-acp-provider.js";
import { GrokHeadlessProvider } from "./grok-headless.js";
import type { PeerProvider } from "./types.js";

/**
 * Select Grok transport.
 *
 * - `headless` (default): `grok -p` / `--prompt-file` with full CLI flag matrix
 * - `acp`: warm `grok agent stdio` process pool (lower multi-turn latency)
 *
 * Env: `PEER_AGENTS_GROK_TRANSPORT=headless|acp`
 */
export function createGrokProvider(): PeerProvider {
  const transport = (
    process.env.PEER_AGENTS_GROK_TRANSPORT ?? "headless"
  ).toLowerCase();
  if (transport === "acp") {
    return new GrokAcpProvider();
  }
  return new GrokHeadlessProvider();
}

export function isGrokAcpTransportEnabled(): boolean {
  return (process.env.PEER_AGENTS_GROK_TRANSPORT ?? "headless").toLowerCase() ===
    "acp";
}
