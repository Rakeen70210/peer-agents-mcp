import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildAttachmentManifest,
  classifyAttachments,
  decodeBinaryContent,
  isBinaryAttachment,
  isValidBinaryContent,
  prependAttachmentManifest,
  resolveSafePath,
  stageAttachments,
} from "../src/attachments.js";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("resolveSafePath blocks directory traversal", () => {
  assert.throws(
    () => resolveSafePath("/tmp/repo", "../../etc/passwd"),
    /Directory traversal/,
  );
});

test("classifyAttachments splits text and binary files", () => {
  const result = classifyAttachments([
    { path: "src/index.ts", content: "export const x = 1;" },
    { path: "ui/screen.png", content: `data:image/png;base64,${PNG_BASE64}` },
  ]);
  assert.equal(result.textFiles.length, 1);
  assert.equal(result.binaryFiles.length, 1);
  assert.equal(result.textFiles[0]?.path, "src/index.ts");
  assert.equal(result.binaryFiles[0]?.path, "ui/screen.png");
});

test("decodeBinaryContent handles data URI", () => {
  const buffer = decodeBinaryContent(`data:image/png;base64,${PNG_BASE64}`);
  assert.equal(buffer[0], 0x89);
  assert.equal(buffer[1], 0x50);
});

test("stageAttachments writes PNG and cleanup removes staging dir", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "peer-agents-attach-"));
  const staged = await stageAttachments(repoPath, [
    {
      path: "screenshots/login.png",
      content: `data:image/png;base64,${PNG_BASE64}`,
    },
  ]);

  assert.equal(staged.files.length, 1);
  assert.match(staged.files[0]?.repoRelativePath ?? "", /\.peer-agents-staging-/);
  assert.match(staged.files[0]?.repoRelativePath ?? "", /login\.png$/);

  const absolutePath = resolveSafePath(
    repoPath,
    staged.files[0]?.repoRelativePath ?? "",
  );
  await access(absolutePath);
  const manifest = buildAttachmentManifest(staged.files);
  assert.match(manifest, /login\.png/);
  assert.match(manifest, /view_file/);

  await staged.cleanup.dispose();
  await assert.rejects(access(absolutePath));
});

test("prependAttachmentManifest places manifest before task prompt", () => {
  const manifest = buildAttachmentManifest([
    {
      originalPath: "ui/a.png",
      repoRelativePath: ".peer-agents-staging-1/a.png",
      mediaType: "Image",
    },
  ]);
  const combined = prependAttachmentManifest("Review this UI.", manifest);
  assert.match(combined, /^### Staged workspace attachments/);
  assert.match(combined, /Review this UI\.$/);
});

test("isValidBinaryContent rejects prose descriptions", () => {
  assert.equal(isValidBinaryContent("This screenshot shows a clipped button."), false);
  assert.equal(isValidBinaryContent(`data:image/png;base64,${PNG_BASE64}`), true);
});

test("isBinaryAttachment detects multimodal extension", () => {
  assert.equal(isBinaryAttachment("doc/spec.pdf", "plain text"), true);
  assert.equal(isBinaryAttachment("src/a.ts", "export {}"), false);
});