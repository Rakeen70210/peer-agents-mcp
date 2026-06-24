import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { parsePositiveInt } from "./providers/runner.js";
import type { PeerFileAttachment } from "./providers/types.js";

export const MULTIMODAL_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".pdf",
  ".mp4",
  ".mov",
  ".wav",
  ".mp3",
]);

const DATA_URI_PATTERN = /^data:([^;]+);base64,(.*)$/s;

export type StagedAttachment = {
  originalPath: string;
  repoRelativePath: string;
  mediaType: string;
};

export class AttachmentCleanup {
  constructor(private readonly absoluteDir: string) {}

  async dispose(): Promise<void> {
    await rm(this.absoluteDir, { recursive: true, force: true });
  }
}

export function hasMultimodalExtension(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return [...MULTIMODAL_EXTENSIONS].some((ext) => lower.endsWith(ext));
}

export function isBinaryAttachment(filePath: string, content: string): boolean {
  const trimmed = content.trim();
  if (DATA_URI_PATTERN.test(trimmed)) {
    return true;
  }
  return hasMultimodalExtension(filePath);
}

export function classifyAttachments(files: PeerFileAttachment[]): {
  textFiles: PeerFileAttachment[];
  binaryFiles: PeerFileAttachment[];
} {
  const textFiles: PeerFileAttachment[] = [];
  const binaryFiles: PeerFileAttachment[] = [];
  for (const file of files) {
    if (isBinaryAttachment(file.path, file.content)) {
      binaryFiles.push(file);
    } else {
      textFiles.push(file);
    }
  }
  return { textFiles, binaryFiles };
}

export function resolveSafePath(repoPath: string, relativePath: string): string {
  const resolved = path.resolve(repoPath, relativePath);
  const relative = path.relative(repoPath, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Directory traversal attempt detected: ${relativePath}`);
  }
  return resolved;
}

export function decodeBinaryContent(content: string): Buffer {
  const trimmed = content.trim();
  const dataUriMatch = trimmed.match(DATA_URI_PATTERN);
  if (dataUriMatch) {
    return Buffer.from(dataUriMatch[2], "base64");
  }
  return Buffer.from(trimmed, "base64");
}

export function isValidBinaryContent(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (DATA_URI_PATTERN.test(trimmed)) {
    return true;
  }
  if (trimmed.length % 4 !== 0) {
    return false;
  }
  if (!/^[A-Za-z0-9+/=\s]+$/.test(trimmed)) {
    return false;
  }
  try {
    const buffer = Buffer.from(trimmed.replace(/\s+/g, ""), "base64");
    return buffer.length > 0;
  } catch {
    return false;
  }
}

function stagingDirPrefix(): string {
  const configured = process.env.PEER_AGENTS_STAGING_DIR?.trim();
  return configured || ".peer-agents-staging";
}

function mediaTypeForPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].some((ext) => lower.endsWith(ext))) {
    return "Image";
  }
  if (lower.endsWith(".pdf")) {
    return "Document";
  }
  if ([".mp4", ".mov"].some((ext) => lower.endsWith(ext))) {
    return "Video";
  }
  if ([".wav", ".mp3"].some((ext) => lower.endsWith(ext))) {
    return "Audio";
  }
  return "Binary";
}

export async function stageAttachments(
  repoPath: string,
  files: PeerFileAttachment[],
): Promise<{ files: StagedAttachment[]; cleanup: AttachmentCleanup }> {
  if (files.length === 0) {
    throw new Error("stageAttachments requires at least one binary file");
  }

  const stagingDirName = `${stagingDirPrefix()}-${randomUUID()}`;
  const stagingDirAbsolute = resolveSafePath(repoPath, stagingDirName);
  await mkdir(stagingDirAbsolute, { recursive: true });

  const staged: StagedAttachment[] = [];
  for (const file of files) {
    const fileName = path.basename(file.path);
    const repoRelativePath = path.join(stagingDirName, fileName);
    const absolutePath = resolveSafePath(repoPath, repoRelativePath);
    const buffer = decodeBinaryContent(file.content);
    await writeFile(absolutePath, buffer);
    staged.push({
      originalPath: file.path,
      repoRelativePath,
      mediaType: mediaTypeForPath(file.path),
    });
  }

  return {
    files: staged,
    cleanup: new AttachmentCleanup(stagingDirAbsolute),
  };
}

export function buildAttachmentManifest(staged: StagedAttachment[]): string {
  if (staged.length === 0) {
    return "";
  }

  const lines = [
    "### Staged workspace attachments",
    "The following files are available in the repository. Use your file-viewing tools (e.g. view_file) to inspect them:",
    ...staged.map(
      (file) =>
        `- **File**: \`${file.repoRelativePath}\` (Type: ${file.mediaType}, source: ${file.originalPath})`,
    ),
    "",
  ];
  return lines.join("\n");
}

export function prependAttachmentManifest(
  prompt: string,
  manifest: string,
): string {
  if (!manifest.trim()) {
    return prompt;
  }
  return `${manifest.trim()}\n\n${prompt}`;
}

export function maxStagingBytes(): number {
  return parsePositiveInt(process.env.PEER_AGENTS_MAX_STAGING_BYTES, 25_000_000);
}