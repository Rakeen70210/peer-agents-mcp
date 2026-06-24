export type PeerProviderName = "grok" | "antigravity";

export type PeerMode = "reviewer" | "planner" | "critic" | "implementer";

export type PeerFileAttachment = {
  path: string;
  content: string;
};

export type PeerRunInput = {
  constructedPrompt: string;
  cwd?: string;
  mode: PeerMode;
  model?: string;
  files?: PeerFileAttachment[];
};

export type PeerRunResult = {
  isError: boolean;
  text: string;
  stdout: string;
  stderr: string;
  nativeSessionId?: string;
};

export interface PeerProvider {
  readonly name: PeerProviderName;
  healthCheck(): Promise<{ ok: boolean; latencyMs: number; detail?: string }>;
  runTurn(input: PeerRunInput): Promise<PeerRunResult>;
}