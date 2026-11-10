import { basename } from "node:path";

import { StartImport } from "@samva/contracts/contacts/import-group";
import { ImportInput, ImportPreset, ImportExportScope } from "@samva/core/contacts/import-job";
import { ContactImportJobId, TopicId } from "@samva/core/shared/base";
import { Console, Effect, FileSystem, Option, Schema } from "effect";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Contacts from "samva/effect/contacts";

import { CliUsageError, toCliApiError } from "../errors";
import { getClientProvider } from "../lib/client";
import { namespaceField, namespaceFlag } from "../lib/namespace";
import { jsonFlag, printFields, printJson } from "../lib/output";

export const importContacts = Command.make("import", {
  preset: Flag.Literals("preset", ImportPreset.literals).pipe(
    Flag.withDescription("beehiiv, substack, kit, or mailchimp"),
  ),
  topic: Flag.String("topic").pipe(
    Flag.withSchema(TopicId),
    Flag.withDescription("Destination topic ID"),
  ),
  files: Flag.String("file").pipe(
    Flag.withDescription(
      "Repeat PATH or EVIDENCE=PATH: status, subscribed, unsubscribed, suppressed, or cleaned/bounced. Missing permission assumes opt-in.",
    ),
    Flag.atLeast(1),
  ),
  namespace: namespaceFlag("create"),
  key: Flag.String("idempotency-key").pipe(
    Flag.withDescription("Stable key for this import; required unless --dry-run"),
    Flag.optional,
  ),
  planHash: Flag.String("plan-hash").pipe(
    Flag.withDescription("Use a saved preview hash to start or replay without a new preview"),
    Flag.optional,
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Call the read-only server preview without starting an import"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Preview or start a status-preserving list migration"),
  Command.withExamples([
    {
      command:
        "samva contacts import --preset kit --topic tpc_7q2xk9mvt4znw8rh --file readers.csv --dry-run --json",
    },
    {
      command:
        "samva contacts import --preset mailchimp --topic tpc_7q2xk9mvt4znw8rh --file subscribed=readers.csv --file cleaned/bounced=cleaned.csv --idempotency-key migration-1 --json",
    },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ preset, topic, files, namespace, key, dryRun, planHash, json }) {
      if (!dryRun && Option.isNone(key))
        return yield* new CliUsageError({
          code: "import_key_required",
          message: "Provide --idempotency-key for this import, or preview with --dry-run.",
        });
      if (dryRun && Option.isSome(planHash))
        return yield* new CliUsageError({
          code: "import_plan_hash_with_dry_run",
          message: "Use --plan-hash to submit a reviewed import; omit it for --dry-run.",
        });
      const fs = yield* FileSystem.FileSystem;
      const input = yield* Schema.decodeUnknownEffect(ImportInput)({
        preset,
        topicId: topic,
        ...namespaceField(namespace),
        files: yield* Effect.forEach(files, (spec) =>
          Effect.gen(function* () {
            const separator = spec.indexOf("=");
            const prefix = separator < 0 ? undefined : spec.slice(0, separator);
            const declared =
              prefix === "status"
                ? { kind: "status_column" as const }
                : Schema.is(ImportExportScope)(prefix)
                  ? { kind: "export_scope" as const, scope: prefix }
                  : undefined;
            const path = declared === undefined ? spec : spec.slice(separator + 1);
            if (path.length === 0)
              return yield* new CliUsageError({
                code: "import_file_invalid",
                message:
                  "Each --file needs PATH or EVIDENCE=PATH, for example readers.csv or unsubscribed=left.csv.",
              });
            const csv = yield* fs.readFileString(path).pipe(
              Effect.mapError(
                () =>
                  new CliUsageError({
                    code: "import_file_unreadable",
                    message: `Could not read import file ${path}.`,
                  }),
              ),
            );
            return {
              name: basename(path),
              csv,
              ...(declared === undefined ? {} : { evidence: declared }),
            };
          }),
        ),
      }).pipe(
        Effect.mapError(
          (error) =>
            new CliUsageError({
              code: "import_input_invalid",
              message: `Import input is invalid: ${error.message}`,
            }),
        ),
      );
      const client = yield* getClientProvider;
      let reviewedHash = Option.getOrUndefined(planHash);
      if (reviewedHash === undefined) {
        const plan = yield* Contacts.planImport(input).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError("Could not preview import", error)),
        );
        if (dryRun) {
          if (json) return yield* printJson(plan);
          yield* printFields([
            ["Can import", plan.canStart],
            ["Subscribed", plan.counts.subscribed],
            ["Unsubscribed", plan.counts.unsubscribed],
            ["Suppressed", plan.counts.suppressed],
            ["Conflicts", plan.counts.conflicts],
          ]);
          for (const diagnostic of plan.diagnostics)
            yield* Console.log(
              `${diagnostic.file}:${diagnostic.row} ${diagnostic.code}: ${diagnostic.message}`,
            );
          return;
        }
        if (!plan.canStart)
          return yield* new CliUsageError({
            code: "import_plan_refused",
            message:
              "The preview refused this import. Run with --dry-run --json to inspect conflicts and file errors.",
          });
        reviewedHash = plan.planHash;
      }
      if (Option.isNone(key))
        return yield* new CliUsageError({
          code: "import_key_required",
          message: "Provide --idempotency-key.",
        });
      const payload = yield* Schema.decodeEffect(StartImport)({
        mode: "new",
        input,
        planHash: reviewedHash,
      }).pipe(
        Effect.mapError(
          (error) => new CliUsageError({ code: "import_input_invalid", message: error.message }),
        ),
      );
      const job = yield* Contacts.startImport(payload, { idempotencyKey: key.value }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not start import", error)),
      );
      if (json) return yield* printJson(job);
      yield* printFields([
        ["Import ID", job.id],
        ["Status", job.status],
        ["Processed", job.processedRows],
        ["Total", job.totalRows],
      ]);
      yield* Console.log(`Check progress with samva contacts import-status ${job.id}`);
    }),
  ),
);

export const importStatus = Command.make("import-status", {
  id: Argument.String("id").pipe(Argument.withSchema(ContactImportJobId)),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Read committed list migration progress"),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, json }) {
      const client = yield* getClientProvider;
      const job = yield* Contacts.getImportJob({ id }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not read import", error)),
      );
      if (json) return yield* printJson(job);
      yield* printFields([
        ["Import ID", job.id],
        ["Status", job.status],
        ["Processed", job.processedRows],
        ["Total", job.totalRows],
        ["Generation", job.generation],
        ["Resumable", job.resumable],
        ["Failure", job.failure?.message],
      ]);
    }),
  ),
);

export const resumeImport = Command.make("import-resume", {
  id: Argument.String("id").pipe(Argument.withSchema(ContactImportJobId)),
  generation: Flag.Int("generation").pipe(
    Flag.withDescription("Failed generation returned by import-status"),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Resume a failed migration using its persisted input"),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, generation, json }) {
      const client = yield* getClientProvider;
      const job = yield* Contacts.startImport({
        mode: "resume",
        jobId: id,
        expectedGeneration: generation,
      }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not resume import", error)),
      );
      if (json) return yield* printJson(job);
      yield* printFields([
        ["Import ID", job.id],
        ["Status", job.status],
        ["Generation", job.generation],
      ]);
    }),
  ),
);
