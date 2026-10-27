import { dirname, resolve } from "node:path";

import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Templates from "samva/effect/templates";

import { resolveExecutionContext } from "../../config/store";
import { CliResultError, SamvaCliError, toCliApiError } from "../../errors";
import { getClientProvider } from "../../lib/client";
import { jsonFlag, printFields, printJson } from "../../lib/output";
import {
  renderTemplateTypes,
  templateTypesDrift,
  type TemplateCatalogEntry,
  type TemplateReferenceKind,
} from "./generated-module";

/**
 * `samva templates types` — generate TypeScript inputs from the authenticated
 * template catalog, and report when the generated file no longer describes it.
 *
 * The default reference is exact: a generated client pins one publication, so
 * the message it sends does not change underneath it. `--reference
 * contract-latest` is the explicit opt-in to follow the newest publication that
 * still validates input identically.
 *
 * `--by slug` generates the helper for callers that send by template slug. The API
 * accepts a publication or contract reference only beside a template id, so a slug
 * send always renders the template's current publication; the file's types follow
 * its input contract, and `--reference` does not apply.
 */

const CATALOG_PAGE_SIZE = 100;
const CATALOG_READ_CONCURRENCY = 8;

const catalogError = (error: unknown) =>
  toCliApiError("Could not read the template catalog", error);

/**
 * The active templates and what each one validates input against. A list row names the template;
 * its publication and input schema are on the template itself, so each active one is read.
 */
const readCatalog = Effect.fn("templates.types.readCatalog")(function* () {
  const client = yield* getClientProvider;
  const ids: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const data = yield* Templates.list({
      cursor,
      limit: CATALOG_PAGE_SIZE,
    }).pipe(client.provide, Effect.mapError(catalogError));
    for (const item of data.items) if (item.isActive) ids.push(item.id);
    if (data.nextCursor === null) break;
    cursor = data.nextCursor;
  }
  return yield* Effect.forEach(
    ids,
    (id) =>
      Templates.getById({ id }).pipe(
        client.provide,
        Effect.mapError(catalogError),
        Effect.map((item): TemplateCatalogEntry => ({
          key: item.slug,
          templateId: item.id,
          ...(item.publicationId === null ? {} : { publicationId: item.publicationId }),
          ...(item.inputContractId === null ? {} : { inputContractId: item.inputContractId }),
          ...(item.inputSchema === null ? {} : { inputSchema: item.inputSchema }),
        })),
      ),
    { concurrency: CATALOG_READ_CONCURRENCY },
  );
});

/**
 * What the generated helper names a template by, and what that sends. By slug there is no
 * reference: the send renders the template's current publication, and the file is stale only when
 * the input contract it was typed from changes.
 */
const keyingRows = (
  by: "id" | "slug",
  reference: TemplateReferenceKind | undefined,
): ReadonlyArray<readonly [string, string]> =>
  by === "slug"
    ? [
        ["By", "slug"],
        ["Publication", "current"],
        ["Drift", "input contract"],
      ]
    : [
        ["By", "id"],
        ["Reference", reference ?? "exact"],
      ];

const readExisting = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return (yield* fs.exists(path)) ? yield* fs.readFileString(path) : undefined;
  }).pipe(
    // @effect-diagnostics-next-line effectSucceedWithVoid:off -- undefined is a real success value (missing file), not a void outcome; Effect.void is not assignable to `string | undefined`.
    Effect.catch(() => Effect.succeed<string | undefined>(undefined)),
  );

export const typesCommand = Command.make("types", {
  out: Flag.String("out").pipe(
    Flag.withDescription("TypeScript file to write the generated template inputs into"),
    Flag.withDefault("samva-templates.ts"),
  ),
  by: Flag.Literals("by", ["id", "slug"]).pipe(
    Flag.withDescription(
      "id keys each send by template id with a reference; slug keys it by template slug and follows the template's current publication",
    ),
    Flag.withDefault("id"),
  ),
  reference: Flag.String("reference").pipe(
    Flag.withDescription(
      "With --by id (default exact): exact pins one publication per template; contract-latest follows the newest publication that validates input identically",
    ),
    Flag.optional,
  ),
  check: Flag.Boolean("check").pipe(
    Flag.withDescription("Report drift without writing; exits 1 when the file is out of date"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Generate typed template inputs from the authenticated catalog"),
  Command.withExamples([
    {
      command: "samva templates types --out src/samva-templates.ts",
      description: "Pin each template's current publication and type its input",
    },
    {
      command: "samva templates types --by slug --out src/samva-templates.ts",
      description: "Type a send that names the template by slug: { templateSlug, templateData }",
    },
    {
      command: "samva templates types --check",
      description: "Fail CI when the generated file no longer matches the catalog",
    },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ out, by, reference: requested, check, json }) {
      const reference = Option.getOrElse(requested, () => "exact");
      if (reference !== "exact" && reference !== "contract-latest") {
        return yield* new SamvaCliError({
          message: `Unknown --reference ${reference}. Use exact or contract-latest.`,
        });
      }
      if (by === "slug" && Option.isSome(requested)) {
        return yield* new SamvaCliError({
          message:
            "--reference does not apply with --by slug: a send by slug renders the template's current publication, and the types follow its input contract.",
        });
      }
      const context = yield* resolveExecutionContext;
      const path = resolve(out);
      const entries = yield* readCatalog();
      const generated = renderTemplateTypes({
        entries,
        by,
        reference: reference as TemplateReferenceKind,
        origin: context.apiUrl,
      });
      if (generated.problems.length > 0) {
        const message = `Could not generate types for ${new Set(generated.problems.map(({ key }) => key)).size} template(s).`;
        return yield* new CliResultError({
          code: "template_types_unsupported_schema",
          message,
          result: {
            action: "templates.types",
            ok: false,
            out: path,
            by,
            ...(generated.manifest.reference === undefined
              ? {}
              : { reference: generated.manifest.reference }),
            problems: generated.problems,
          },
          human: [
            message,
            ...generated.problems.map(
              ({ key, pointer, message: detail }) => `  ${key} ${pointer}: ${detail}`,
            ),
          ].join("\n"),
        });
      }
      const existing = yield* readExisting(path);
      const drift = templateTypesDrift(existing, generated);
      const result = {
        action: "templates.types",
        ok: check ? drift.length === 0 : true,
        out: path,
        by,
        ...(generated.manifest.reference === undefined
          ? {}
          : { reference: generated.manifest.reference }),
        templates: generated.manifest.templates,
        skipped: generated.skipped,
        drift,
        written: false,
      };
      if (check) {
        if (drift.length === 0) {
          if (json) return yield* printJson(result);
          return yield* printFields([
            ["File", path],
            ...keyingRows(by, generated.manifest.reference),
            ["Templates", generated.manifest.templates.length],
            ["Status", "up to date"],
          ]);
        }
        const message = `${path} is ${drift.length} change(s) behind the template catalog.`;
        return yield* new CliResultError({
          code: "template_types_stale",
          message,
          result,
          human: [
            message,
            ...drift.map(({ detail }) => `  ${detail}`),
            "",
            "Run `samva templates types` to regenerate.",
          ].join("\n"),
        });
      }
      const fs = yield* FileSystem.FileSystem;
      yield* fs
        .makeDirectory(dirname(path), { recursive: true })
        .pipe(Effect.catch(() => Effect.void));
      yield* fs
        .writeFileString(path, generated.source)
        .pipe(
          Effect.mapError(
            (cause) => new SamvaCliError({ message: `Could not write ${path}: ${String(cause)}` }),
          ),
        );
      const written = { ...result, written: true };
      if (json) return yield* printJson(written);
      yield* printFields([
        ["File", path],
        ...keyingRows(by, generated.manifest.reference),
        ["Templates", generated.manifest.templates.length],
        ["Skipped", generated.skipped.length],
      ]);
      for (const { key, reason } of generated.skipped)
        yield* Effect.logInfo(`Skipped ${key}: ${reason}`);
    }),
  ),
);
