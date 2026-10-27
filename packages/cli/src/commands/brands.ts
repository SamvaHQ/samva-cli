import { join, relative, resolve } from "node:path";

import { parseBrandCss } from "@samva/markup/brand";
import { buildLineMap, lineColumn } from "@samva/markup/diagnostics";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Brands from "samva/effect/brands";

import { CliResultError, CliUsageError, SamvaCliError, toCliApiError } from "../errors";
import { getClientProvider } from "../lib/client";
import { confirmDestructive } from "../lib/confirm";
import { jsonFlag, printFields, printJson, truncateForDisplay } from "../lib/output";

/**
 * `samva brands` — the organization's brands from a terminal. `pull` writes the
 * snapshot the template commands resolve `samva:brand` from when it cannot reach the
 * API; `push` validates brand CSS against the grammar the API enforces before
 * uploading it. Neither touches the project's `theme.css`, which imports the
 * brand rather than copying it. `default` and `remove` change which brands the
 * organization holds; the API refuses to remove the default brand.
 */

/**
 * Where a pulled brand lives inside an email project. The template resolver reads the
 * same path; the directory is gitignored because
 * the API, not the repository, owns the brand.
 */
const SNAPSHOT_DIR = [".samva", "brands"] as const;
const SNAPSHOT_VERSION = 1;

const slugArgument = Argument.String("slug").pipe(
  Argument.withDescription("Brand slug; omit for the organization's default brand"),
  Argument.optional,
);

const projectFlag = Flag.Directory("project").pipe(
  Flag.withDescription("Email project root (where theme.css lives)"),
  Flag.withDefault("."),
);

const apiFailure = (prefix: string) => (error: unknown) => toCliApiError(prefix, error);

/** One brand by slug, or the organization's default brand when no slug is given. */
const fetchBrand = (slug: string | undefined) =>
  Effect.gen(function* () {
    const client = yield* getClientProvider;
    if (slug !== undefined)
      return yield* Brands.get({ slug }).pipe(
        client.provide,
        Effect.mapError(apiFailure(`Could not get brand ${slug}`)),
      );
    const { items } = yield* Brands.list().pipe(
      client.provide,
      Effect.mapError(apiFailure("Could not list brands")),
    );
    const brand = items.find((item) => item.isDefault);
    if (brand === undefined)
      return yield* new SamvaCliError({
        message: "This organization has no default brand. Name one: samva brands pull <slug>.",
      });
    return brand;
  });

const list = Command.make("list", { json: jsonFlag }).pipe(
  Command.withDescription("List the organization's brands, the default brand first"),
  Command.withExamples([
    { command: "samva brands list" },
    { command: "samva brands list --json", description: "Machine-readable brand list" },
  ]),
  Command.withHandler(({ json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Brands.list().pipe(
        client.provide,
        Effect.mapError(apiFailure("Could not list brands")),
      );
      if (json) return yield* printJson(data);
      if (data.items.length === 0) return yield* Console.log("No brands found.");
      yield* Console.log(
        data.items
          .map(
            (brand) =>
              `${brand.isDefault ? "* " : "  "}${brand.slug}  ${brand.name}  ${brand.digest.slice(0, 12)}`,
          )
          .join("\n"),
      );
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const get = Command.make("get", { slug: slugArgument, json: jsonFlag }).pipe(
  Command.withDescription("Show one brand: its CSS, assets, footer and digest"),
  Command.withExamples([
    { command: "samva brands get", description: "Show the default brand" },
    { command: "samva brands get acme --json" },
  ]),
  Command.withHandler(({ slug, json }) =>
    Effect.gen(function* () {
      const brand = yield* fetchBrand(Option.getOrUndefined(slug));
      if (json) return yield* printJson(brand);
      yield* printFields([
        ["Slug", brand.slug],
        ["Name", brand.name],
        ["Default", brand.isDefault ? "yes" : "no"],
        ["Digest", brand.digest],
        ["Updated", brand.updatedAt],
        ["Logo", brand.assets.logoUrl],
        ["Company", brand.footer.companyName],
      ]);
      yield* Console.log(`\n${truncateForDisplay(brand.css)}`);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const pull = Command.make("pull", {
  slug: slugArgument,
  project: projectFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Write a brand snapshot to .samva/brands/<slug>.json, which samva:brand resolves from offline. Never touches theme.css.",
  ),
  Command.withExamples([
    { command: "samva brands pull", description: "Snapshot the default brand" },
    { command: "samva brands pull acme --project ./emails-project" },
  ]),
  Command.withHandler(({ slug, project, json }) =>
    Effect.gen(function* () {
      const brand = yield* fetchBrand(Option.getOrUndefined(slug));
      const pulledAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      const root = resolve(project);
      const directory = join(root, ...SNAPSHOT_DIR);
      const path = join(directory, `${brand.slug}.json`);
      const snapshot = {
        version: SNAPSHOT_VERSION,
        slug: brand.slug,
        name: brand.name,
        isDefault: brand.isDefault,
        css: brand.css,
        assets: brand.assets,
        footer: brand.footer,
        digest: brand.digest,
        pulledAt,
      };
      const fs = yield* FileSystem.FileSystem;
      yield* Effect.gen(function* () {
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(path, `${JSON.stringify(snapshot, null, 2)}\n`);
      }).pipe(
        Effect.mapError(
          (cause) => new SamvaCliError({ message: `Could not write ${path}: ${String(cause)}` }),
        ),
      );
      const result = {
        action: "brands.pull",
        slug: brand.slug,
        name: brand.name,
        isDefault: brand.isDefault,
        digest: brand.digest,
        path: relative(process.cwd(), path),
        pulledAt,
      };
      if (json) return yield* printJson(result);
      yield* Console.log(`Pulled brand ${brand.slug} (${brand.name}) to ${result.path}.`);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const push = Command.make("push", {
  file: Argument.String("file").pipe(Argument.withDescription("Brand CSS file to upload")),
  brand: Flag.String("brand").pipe(
    Flag.withDescription(
      "Slug of the brand to update; defaults to the organization's default brand",
    ),
    Flag.optional,
  ),
  name: Flag.String("name").pipe(
    Flag.withDescription("Also set the brand's display name"),
    Flag.optional,
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Validate the CSS locally without uploading it"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Validate brand CSS locally and replace a brand's CSS with it. Published templates keep their brand until republished.",
  ),
  Command.withExamples([
    { command: "samva brands push brand.css", description: "Update the default brand's CSS" },
    { command: "samva brands push brand.css --brand acme --dry-run" },
    { command: 'samva brands push brand.css --name "Acme"', description: "Also rename the brand" },
  ]),
  Command.withHandler(({ file, brand, name, dryRun, json }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const css = yield* fs.readFileString(file).pipe(
        Effect.mapError(
          () =>
            new CliUsageError({
              code: "brand_css_unreadable",
              message: `Could not read brand CSS from ${file}.`,
            }),
        ),
      );
      const parsed = parseBrandCss(css);
      if (parsed.isErr()) {
        const lines = buildLineMap(css);
        const findings = parsed.error.map((finding) => ({
          code: finding.code,
          message: finding.message,
          ...lineColumn(lines, finding.span.start),
        }));
        const message = `${file} is not valid brand CSS.`;
        return yield* new CliResultError({
          code: "invalid_brand_css",
          message,
          result: { action: "brands.push", file, ok: false, findings },
          human: [
            message,
            ...findings.map(
              (finding) =>
                `${file}:${finding.line}:${finding.column} ${finding.code}: ${finding.message}`,
            ),
          ].join("\n"),
        });
      }
      const named = Option.getOrUndefined(brand);
      if (dryRun) {
        const result = {
          dryRun: true,
          action: "brands.push",
          file,
          brand: named ?? null,
          ok: true,
        };
        if (json) return yield* printJson(result);
        return yield* Console.log(`${file} is valid brand CSS. Nothing was uploaded.`);
      }
      const slug = named ?? (yield* fetchBrand(undefined)).slug;
      const client = yield* getClientProvider;
      const updated = yield* Brands.update({
        slug,
        css,
        ...(Option.isSome(name) ? { name: name.value } : {}),
      }).pipe(client.provide, Effect.mapError(apiFailure(`Could not update brand ${slug}`)));
      const result = {
        action: "brands.push",
        file,
        slug: updated.slug,
        digest: updated.digest,
        ok: true,
      };
      if (json) return yield* printJson(result);
      yield* Console.log(`Updated brand ${updated.slug} from ${file}.`);
      yield* Effect.logInfo(
        "Published templates keep the brand they were built against until they are republished.",
      );
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const requiredSlugArgument = Argument.String("slug").pipe(Argument.withDescription("Brand slug"));

const dryRunFlag = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Print the request without sending it"),
  Flag.withDefault(false),
);

const yesFlag = Flag.Boolean("yes").pipe(
  Flag.withDescription("Confirm without prompting (required outside a terminal)"),
  Flag.withDefault(false),
);

const makeDefault = Command.make("default", {
  slug: requiredSlugArgument,
  dryRun: dryRunFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Make a brand the organization's default: bare samva:brand and domains without a brand resolve to it",
  ),
  Command.withExamples([
    { command: "samva brands default acme" },
    { command: "samva brands default acme --dry-run --json" },
  ]),
  Command.withHandler(({ slug, dryRun, json }) =>
    Effect.gen(function* () {
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "brands.default", slug })
          : Console.log(`[dry-run] Would make brand ${slug} the default.`);
      const client = yield* getClientProvider;
      const brand = yield* Brands.setDefault({ slug }).pipe(
        client.provide,
        Effect.mapError(apiFailure(`Could not make brand ${slug} the default`)),
      );
      const result = {
        action: "brands.default",
        slug: brand.slug,
        name: brand.name,
        isDefault: brand.isDefault,
      };
      if (json) return yield* printJson(result);
      yield* Console.log(`Brand ${brand.slug} (${brand.name}) is now the default.`);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const remove = Command.make("remove", {
  slug: requiredSlugArgument,
  dryRun: dryRunFlag,
  yes: yesFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Permanently delete a brand. The default brand cannot be deleted; make another brand the default first. Domains that used it fall back to the default.",
  ),
  Command.withExamples([
    { command: "samva brands remove promo --dry-run" },
    { command: "samva brands remove promo --yes" },
  ]),
  Command.withHandler(({ slug, dryRun, yes, json }) =>
    Effect.gen(function* () {
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "brands.remove", slug })
          : Console.log(`[dry-run] Would permanently remove brand ${slug}.`);
      yield* confirmDestructive({
        yes,
        json,
        message: `Permanently remove brand ${slug}?`,
        nonInteractiveMessage:
          "Permanent brand deletion requires --yes in non-interactive mode. Preview with --dry-run.",
      });
      const client = yield* getClientProvider;
      yield* Brands.remove({ slug }).pipe(
        client.provide,
        Effect.mapError(apiFailure(`Could not remove brand ${slug}`)),
      );
      const result = { action: "brands.remove", slug, removed: true };
      if (json) return yield* printJson(result);
      yield* Console.log(`Removed brand ${slug}.`);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

export const brandsCommand = Command.make("brands").pipe(
  Command.withDescription(
    "List, snapshot, update, and delete the organization's brands (what samva:brand resolves to)",
  ),
  Command.withExamples([
    { command: "samva brands list" },
    { command: "samva brands pull", description: "Snapshot the default brand for offline builds" },
    { command: "samva brands push brand.css --brand acme" },
    { command: "samva brands default acme", description: "Make acme the default brand" },
    { command: "samva brands remove promo --yes" },
  ]),
  Command.withSubcommands([list, get, pull, push, makeDefault, remove]),
);
