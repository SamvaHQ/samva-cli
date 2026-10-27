import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

import {
  EMAIL_ATTACHMENT_BUDGET,
  emailAttachmentBudgetMessage,
  emailAttachmentBudgetViolation,
} from "@samva/core/messages/attachment-budget";
import * as Effect from "effect/Effect";
import type { EmailSendInput } from "samva/effect/email";

import { CliUsageError } from "../errors";

type SendAttachment = NonNullable<EmailSendInput["attachments"]>[number];

/** A file named by `--attach`, read in full before any request is made. */
export interface LocalAttachment {
  readonly path: string;
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".ics": "text/calendar",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
  ".zip": "application/zip",
};

export const contentTypeForPath = (path: string): string =>
  CONTENT_TYPE_BY_EXTENSION[extname(path).toLowerCase()] ?? "application/octet-stream";

const attachmentError = (code: string, message: string) => new CliUsageError({ code, message });

const describeCause = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const unreadable = (path: string) => (cause: unknown) =>
  attachmentError("attachment_unreadable", `Cannot read --attach ${path}: ${describeCause(cause)}`);

/** Enforce `EMAIL_ATTACHMENT_BUDGET` on the sizes of the named files. */
const checkAttachmentBudget = (
  files: ReadonlyArray<{ readonly path: string; readonly size: number }>,
): Effect.Effect<void, CliUsageError> =>
  Effect.gen(function* () {
    for (const file of files) {
      if (file.size === 0) {
        return yield* attachmentError(
          "attachment_empty",
          `--attach ${file.path} is empty; an attachment must be at least 1 byte.`,
        );
      }
      if (file.size > EMAIL_ATTACHMENT_BUDGET.maxItemBytes) {
        return yield* attachmentError(
          "attachment_too_large",
          `--attach ${file.path} is ${file.size} bytes; each attachment must be at most ${EMAIL_ATTACHMENT_BUDGET.maxItemBytes} bytes.`,
        );
      }
    }
    const violation = emailAttachmentBudgetViolation(files);
    if (violation !== null) {
      const total = files.reduce((sum, file) => sum + file.size, 0);
      return yield* attachmentError(
        `attachment_budget_${violation}`,
        `${emailAttachmentBudgetMessage(violation)} (got ${files.length} files, ${total} bytes).`,
      );
    }
  });

/**
 * Read every `--attach` path within `EMAIL_ATTACHMENT_BUDGET`, failing with a usage error that
 * names the path or limit before any request. Sizes are checked before any file is read, so an
 * oversized file is never loaded, and again on the bytes read, in case a file grew in between.
 */
export const readAttachments = (
  paths: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<LocalAttachment>, CliUsageError> =>
  Effect.gen(function* () {
    const sizes = yield* Effect.forEach(paths, (path) =>
      Effect.tryPromise({
        try: async () => ({ path, size: (await stat(path)).size }),
        catch: unreadable(path),
      }),
    );
    yield* checkAttachmentBudget(sizes);
    const files = yield* Effect.forEach(paths, (path) =>
      Effect.tryPromise({
        try: async (): Promise<LocalAttachment> => ({
          path,
          filename: basename(path),
          contentType: contentTypeForPath(path),
          bytes: await readFile(path),
        }),
        catch: unreadable(path),
      }),
    );
    yield* checkAttachmentBudget(
      files.map((file) => ({ path: file.path, size: file.bytes.length })),
    );
    return files;
  });

/** Send attachments as inline Base64; the SDK uploads the largest through media past the inline limit. */
export const toSendAttachments = (
  files: ReadonlyArray<LocalAttachment>,
): ReadonlyArray<SendAttachment> =>
  files.map((file) => ({
    filename: file.filename,
    contentType: file.contentType,
    size: file.bytes.length,
    content: Buffer.from(file.bytes).toString("base64"),
  }));
