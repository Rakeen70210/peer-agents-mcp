import { z } from "zod";

export const repoPathSchema = z
  .string()
  .describe(
    "Absolute path to the repository root the peer should work in (e.g. /home/user/my-app).",
  );

export const idempotencyKeySchema = z
  .string()
  .describe(
    "Stable key for this operation (e.g. review-auth-jwt-1). Reuse the same key when retrying after timeout.",
  );

export const fileAttachmentSchema = z.object({
  path: z
    .string()
    .describe("Repo-relative file path (e.g. src/auth/jwt.ts)."),
  content: z
    .string()
    .describe(
      "Text file contents, or base64/data-URI for images/PDFs/video. " +
        "Binary attachments are staged to disk automatically when routed to Antigravity.",
    ),
});

export const filesSchema = z
  .array(fileAttachmentSchema)
  .optional()
  .describe(
    "Changed source files and binary attachments (screenshots, PDFs). " +
      "Use correct file extensions for images/PDFs and pass base64 or data-URI content.",
  );

export const diffSchema = z
  .string()
  .optional()
  .describe(
    "Full unified diff or patch output. Never substitute a prose summary for the actual diff.",
  );

export const taskSchema = z
  .string()
  .optional()
  .describe(
    "Human-readable session label: what you are trying to achieve, affected behavior, and specific concerns for the peer.",
  );

export const focusSchema = z
  .enum(["bugs", "architecture", "security", "tests", "general"])
  .optional()
  .describe(
    "Primary review lens. Pair with a detailed diff, related files, and a rich `task` describing risks.",
  );

export const riskSchema = z
  .enum(["low", "medium", "high"])
  .optional()
  .describe(
    "Use high for auth, payments, migrations, concurrency, and public API changes.",
  );

export const complexitySchema = z
  .enum(["simple", "complex"])
  .optional()
  .describe(
    "complex when the change spans multiple modules, data paths, or deployment steps.",
  );