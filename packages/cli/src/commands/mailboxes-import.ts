import { lstat, open, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { MailboxId } from "@samva/core/shared/base";
import { Console, Effect, Redacted, Schedule } from "effect";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Mailboxes from "samva/effect/mailboxes";

import { CliResultError, CliUsageError, SamvaCliError, toCliApiError } from "../errors";
import { getClientProvider } from "../lib/client";
import { jsonFlag, printFields, printJson } from "../lib/output";

interface ArchiveFile {
  readonly path: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly format: "apple" | "mbox";
  readonly mailboxPath?: string;
  readonly tableOfContents?: "missing" | "binary-plist" | "unrecognized";
  readonly warnings?: ReadonlyArray<string>;
}

const pathError = (path: string, cause: unknown) =>
  new CliUsageError({
    code: "mail_import_path_invalid",
    message: `Cannot import ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });
const stat = (path: string) =>
  Effect.tryPromise({ try: () => lstat(path), catch: (cause) => pathError(path, cause) });

const inspectTableOfContents = (path: string) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({ try: () => open(path, "r"), catch: (cause) => pathError(path, cause) }),
    (handle) =>
      Effect.tryPromise({
        try: async () => {
          const header = new Uint8Array(8);
          const { bytesRead } = await handle.read(header, 0, header.length, 0);
          return bytesRead === 8 && new TextDecoder().decode(header) === "bplist00"
            ? ("binary-plist" as const)
            : ("unrecognized" as const);
        },
        catch: (cause) => pathError(path, cause),
      }),
    (handle) => Effect.promise(() => handle.close()),
  );

const discoverDirectory = (
  directory: string,
  parts: string[],
): Effect.Effect<ArchiveFile[], CliUsageError> =>
  Effect.gen(function* () {
    const entries = yield* Effect.tryPromise({
      try: () => readdir(directory, { withFileTypes: true }),
      catch: (cause) => pathError(directory, cause),
    });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const files: ArchiveFile[] = [];
    const mbox = entries.find((entry) => entry.name === "mbox" && entry.isFile());
    if (mbox !== undefined) {
      const path = join(directory, mbox.name);
      const toc = entries.find((entry) => entry.name === "table_of_contents" && entry.isFile());
      const tableOfContents =
        toc === undefined ? "missing" : yield* inspectTableOfContents(join(directory, toc.name));
      files.push({
        path,
        filename: basename(directory),
        sizeBytes: (yield* stat(path)).size,
        format: "apple",
        mailboxPath: parts.join("/"),
        tableOfContents,
        warnings: [
          tableOfContents === "missing"
            ? "Apple table_of_contents is absent; MIME Status/X-Status flags apply, otherwise mail is read and unflagged."
            : `Apple table_of_contents (${tableOfContents}) does not provide reliably decoded flags; MIME Status/X-Status flags apply, otherwise mail is read and unflagged.`,
        ],
      });
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink())
        return yield* pathError(directory, `Export contains a symbolic link: ${entry.name}.`);
      if (entry.isDirectory())
        files.push(
          ...(yield* discoverDirectory(join(directory, entry.name), [
            ...parts,
            entry.name.replace(/\.mbox$/i, ""),
          ])),
        );
    }
    return files;
  });

/** Discover packages without reading message bytes or following links outside the export. */
export const discoverMailArchives = Effect.fn("MailImport.discoverArchives")(function* (
  input: string,
) {
  const root = resolve(input);
  const rootInfo = yield* stat(root);
  if (rootInfo.isFile() && rootInfo.size === 0)
    return yield* pathError(
      input,
      "The mbox file is empty; choose a mailbox export containing messages.",
    );
  if (rootInfo.isFile())
    return [
      { path: root, filename: basename(root), sizeBytes: rootInfo.size, format: "mbox" as const },
    ];
  if (!rootInfo.isDirectory())
    return yield* pathError(input, "Choose a file or directory, not a symbolic link.");
  const files = yield* discoverDirectory(
    root,
    /\.mbox$/i.test(basename(root)) ? [basename(root).replace(/\.mbox$/i, "")] : [],
  );
  if (files.length === 0)
    return yield* pathError(input, "No Apple Mail packages containing an mbox file found.");
  return files;
});

const uploadArchive = Effect.fn("MailImport.uploadArchive")(function* (
  file: ArchiveFile,
  url: string,
) {
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/mbox", "content-length": String(file.sizeBytes) },
        body: Bun.file(file.path),
        redirect: "manual",
        signal,
      }),
    catch: (cause) =>
      new SamvaCliError({ message: `Upload failed for ${file.path}: ${String(cause)}` }),
  });
  if (!response.ok)
    return yield* new SamvaCliError({
      message: `Upload failed for ${file.path}: HTTP ${response.status}.`,
    });
});

const archivePriority = (file: ArchiveFile): number => {
  const folder = file.mailboxPath?.toLowerCase();
  if (folder === "inbox") return 0;
  if (folder === "sent" || folder === "sent messages") return 1;
  if (folder === "archive") return 2;
  return 3;
};

const importError = (error: SamvaCliError, mailboxId: string, importId: string | undefined) => {
  if (importId === undefined) return error;
  const recoveryCommand = `samva mailboxes import-status ${mailboxId} ${importId}`;
  return new SamvaCliError({
    message: `${error.message} Import ${importId} remains available. Inspect it with ${recoveryCommand}.`,
    api: error.api,
    details: { ...error.details, importId, recoveryCommand },
  });
};

const mailboxArgument = Argument.String("mailbox-id").pipe(Argument.withSchema(MailboxId));

export const mailboxesImportCommand = Command.make("import", {
  mailbox: mailboxArgument,
  path: Argument.String("path").pipe(
    Argument.withDescription("Plain mbox, Apple .mbox package, or exported package tree"),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDefault(false),
    Flag.withDescription("List archives without uploading or importing"),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Upload exported mail into an existing mailbox as history, without live-mail events",
  ),
  Command.withExamples([
    { command: "samva mailboxes import mbx_1234567890123456 Takeout/Mail/All-mail.mbox" },
    { command: 'samva mailboxes import mbx_1234567890123456 "Inbox.mbox"' },
    { command: "samva mailboxes import mbx_1234567890123456 ./Mail-export --dry-run --json" },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ mailbox, path, dryRun, json }) {
      const discovered = yield* discoverMailArchives(path);
      const skippedEmpty = discovered
        .filter((file) => file.format === "apple" && file.sizeBytes === 0)
        .map((file) => ({
          path: file.path,
          mailboxPath: file.mailboxPath,
          reason: "empty" as const,
        }));
      const files = discovered
        .filter((file) => file.sizeBytes > 0)
        .toSorted(
          (left, right) =>
            archivePriority(left) - archivePriority(right) ||
            (left.mailboxPath ?? left.path).localeCompare(right.mailboxPath ?? right.path),
        );
      const skippedLines = skippedEmpty.map(
        (file) => `Skipped empty Apple mailbox ${file.mailboxPath}: ${file.path}.`,
      );
      if (!json) for (const line of skippedLines) yield* Console.log(line);
      if (dryRun) {
        if (json)
          return yield* printJson({ dryRun: true, mailboxId: mailbox, files, skippedEmpty });
        for (const file of files) {
          yield* Console.log(
            `[dry-run] ${file.path} (${file.sizeBytes} bytes; ${file.mailboxPath ?? file.format}).`,
          );
          for (const warning of file.warnings ?? []) yield* Console.log(warning);
        }
        return;
      }
      if (files.length === 0) {
        if (json) yield* printJson({ items: [], files: [], skippedEmpty });
        return;
      }
      const client = yield* getClientProvider;
      let importId: string | undefined;
      for (const file of files) {
        yield* Effect.logInfo(`Uploading ${file.path} (${file.sizeBytes} bytes).`);
        const target = yield* Mailboxes.createImportUpload({
          id: mailbox,
          filename: file.filename,
          sizeBytes: file.sizeBytes,
          format: file.format,
          ...(file.mailboxPath === undefined ? {} : { mailboxPath: file.mailboxPath }),
          ...(importId === undefined ? {} : { importId }),
        }).pipe(
          client.provide,
          Effect.mapError((error) =>
            importError(
              toCliApiError("Could not create mail import upload", error),
              mailbox,
              importId,
            ),
          ),
        );
        if (importId !== undefined && target.id !== importId)
          return yield* importError(
            new SamvaCliError({
              message:
                "The API returned a different import ID while adding an archive to the queued import.",
            }),
            mailbox,
            importId,
          );
        importId = target.id;
        yield* uploadArchive(file, Redacted.value(target.uploadUrl)).pipe(
          Effect.mapError((error) => importError(error, mailbox, importId)),
        );
      }
      if (importId === undefined)
        return yield* new SamvaCliError({
          message: "No archive upload was accepted for this import.",
        });
      const initial = yield* Mailboxes.startImport({ id: mailbox, importId }).pipe(
        client.provide,
        Effect.mapError((error) =>
          importError(toCliApiError("Could not start mail import", error), mailbox, importId),
        ),
      );
      yield* Effect.logInfo(`Import ${initial.id}: ${initial.status}.`);
      const job =
        initial.status === "done" || initial.status === "failed"
          ? initial
          : yield* Mailboxes.getImport({ id: mailbox, importId }).pipe(
              client.provide,
              Effect.mapError((error) =>
                importError(
                  toCliApiError("Could not read mail import progress", error),
                  mailbox,
                  importId,
                ),
              ),
              Effect.tap((progress) =>
                Effect.logInfo(
                  `Import ${progress.id}: ${progress.status}; imported ${progress.imported}, duplicates ${progress.skippedDuplicate}, spam/trash ${progress.skippedSpamTrash}, failed ${progress.failed}.`,
                ),
              ),
              Effect.repeat({
                schedule: Schedule.spaced("2 seconds"),
                while: (progress) => progress.status === "queued" || progress.status === "running",
              }),
            );
      const sourceFiles = files.map(
        ({ path: archivePath, sizeBytes, format, mailboxPath, tableOfContents, warnings }) => ({
          path: archivePath,
          sizeBytes,
          format,
          ...(mailboxPath === undefined ? {} : { mailboxPath }),
          ...(tableOfContents === undefined ? {} : { tableOfContents, warnings }),
        }),
      );
      const warnings = [...new Set(files.flatMap((file) => file.warnings ?? []))];
      const result = { items: [job], files: sourceFiles, skippedEmpty };
      if (job.status === "failed" || job.failed > 0)
        return yield* new CliResultError({
          code: "mail_import_failed",
          message: `Import ${job.id} has failures. Inspect it with samva mailboxes import-status ${mailbox} ${job.id}.`,
          result,
          human: [
            ...skippedLines,
            ...warnings,
            `Import ${job.id}: ${job.imported} imported, ${job.skippedDuplicate} duplicates, ${job.skippedSpamTrash} spam/trash, ${job.failed} failed.`,
          ].join("\n"),
        });
      if (json) return yield* printJson(result);
      for (const warning of warnings) yield* Console.log(warning);
      yield* printFields([
        ["Import ID", job.id],
        ["Status", job.status],
        ["Archives", files.length],
        ["Imported", job.imported],
        ["Skipped duplicate", job.skippedDuplicate],
        ["Skipped spam/trash", job.skippedSpamTrash],
        ["Failed", job.failed],
      ]);
    }),
  ),
);

export const mailboxesImportStatusCommand = Command.make("import-status", {
  mailbox: mailboxArgument,
  importId: Argument.String("import-id"),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Read a mail history import's progress and failure reasons"),
  Command.withExamples([
    { command: "samva mailboxes import-status mbx_1234567890123456 <import-id> --json" },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ mailbox, importId, json }) {
      const client = yield* getClientProvider;
      const job = yield* Mailboxes.getImport({ id: mailbox, importId }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not read mail import", error)),
      );
      if (json) return yield* printJson(job);
      yield* printFields([
        ["Import ID", job.id],
        ["Status", job.status],
        ["Imported", job.imported],
        ["Skipped duplicate", job.skippedDuplicate],
        ["Skipped spam/trash", job.skippedSpamTrash],
        ["Failed", job.failed],
      ]);
      for (const failure of job.failures)
        yield* Console.log(`${failure.offset}: ${failure.message}`);
    }),
  ),
);
