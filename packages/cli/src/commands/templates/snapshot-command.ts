import { resolve } from "node:path";

import { formatReportedDiagnostic } from "@samva/core/shared/template-diagnostics";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as References from "effect/References";

import { CliResultError, CliUsageError, SamvaCliError } from "../../errors";
import { jsonFlag, printJson } from "../../lib/output";
import { reportDiagnostic } from "./diagnostics";
import { dirFlag, offlineFlag } from "./flags";
import { renderLocal, renderWithProjectAssets } from "./local-render";
import {
  BROWSER_REMEDY,
  defaultLaunchers,
  SCHEMES,
  type SchemeName,
  takeSnapshots,
  VIEWPORTS,
  type ViewportName,
} from "./snapshot-browser";

/** Parse a comma-separated flag against its allowed names. */
const parseChoices = <A extends string>(
  flag: string,
  raw: string,
  allowed: readonly A[],
): Effect.Effect<readonly A[], CliUsageError> => {
  const chosen = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  const unknown = chosen.filter((value) => !allowed.includes(value as A));
  return unknown.length > 0 || chosen.length === 0
    ? Effect.fail(
        new CliUsageError({
          code: "invalid_snapshot_choice",
          message: `--${flag} takes a comma-separated list of ${allowed.join(", ")}${unknown.length > 0 ? `; got ${unknown.join(", ")}` : ""}.`,
        }),
      )
    : Effect.succeed([...new Set(chosen)] as A[]);
};

export const snapshotCommand = Command.make("snapshot", {
  template: Argument.String("template").pipe(
    Argument.withDescription("Template id, or the path of its .tsx entry"),
  ),
  fixture: Flag.String("fixture").pipe(Flag.withDescription("Fixture to screenshot")),
  dir: dirFlag,
  out: Flag.Directory("out").pipe(
    Flag.withDescription("Directory to write the PNGs into"),
    Flag.withDefault(".samva/snapshots"),
  ),
  viewport: Flag.String("viewport").pipe(
    Flag.withDescription(
      `Comma-separated viewports: ${Object.entries(VIEWPORTS)
        .map(([name, size]) => `${name} (${size.width}px)`)
        .join(", ")}`,
    ),
    Flag.withDefault("desktop,mobile"),
  ),
  scheme: Flag.String("scheme").pipe(
    Flag.withDescription("Comma-separated color schemes: light, dark"),
    Flag.withDefault("light,dark"),
  ),
  assetBase: Flag.String("asset-base").pipe(
    Flag.withDescription(
      "HTTPS origin the template's imported assets are served from; omit to use the project's own asset files",
    ),
    Flag.optional,
  ),
  offline: offlineFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Screenshot one fixture in a headless browser at desktop and mobile widths, light and dark",
  ),
  Command.withExamples([
    {
      command: "samva templates snapshot welcome --fixture no-tracking",
      description: "Write four PNGs to .samva/snapshots",
    },
    {
      command:
        "samva templates snapshot welcome --fixture default --viewport mobile --scheme dark --out shots",
      description: "One screenshot: mobile, dark",
    },
  ]),
  Command.withHandler(
    ({ template, fixture, dir, out, viewport, scheme, assetBase, offline, json }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const viewports: readonly ViewportName[] = yield* parseChoices(
            "viewport",
            viewport,
            Object.keys(VIEWPORTS) as ViewportName[],
          );
          const schemes: readonly SchemeName[] = yield* parseChoices("scheme", scheme, SCHEMES);
          const base = Option.getOrUndefined(assetBase);
          if (base !== undefined && !/^https:\/\//i.test(base)) {
            return yield* new CliUsageError({
              code: "invalid_asset_base",
              message: `--asset-base must be an HTTPS origin; got ${base}. Omit it to screenshot with the project's own asset files.`,
            });
          }
          const input = { template, fixture, dir: Option.getOrUndefined(dir) };
          const rendered =
            base === undefined
              ? yield* renderWithProjectAssets({ ...input, channel: "email", offline })
              : yield* renderLocal({ ...input, channel: "email", assetBase: base, offline });
          if (!rendered.ok || !("html" in rendered)) {
            const message = `Could not render ${template} (${fixture}) to screenshot it.`;
            const diagnostics = rendered.diagnostics.map((diagnostic) =>
              reportDiagnostic(diagnostic, { file: "." }),
            );
            if (json) {
              return yield* new CliResultError({
                code: "template_render_failed",
                message,
                result: { action: "templates.snapshot", ok: false, diagnostics },
                human: message,
              });
            }
            for (const diagnostic of diagnostics) {
              yield* Console.error(formatReportedDiagnostic(diagnostic));
            }
            return yield* new SamvaCliError({ message });
          }
          const outDir = resolve(out);
          const shots = yield* Effect.promise(() =>
            takeSnapshots({
              html: rendered.html,
              template: rendered.template,
              fixture,
              outDir,
              viewports,
              schemes,
              launchers: defaultLaunchers(Bun.env),
            }),
          );
          if (!shots.ok) {
            return yield* new SamvaCliError({
              message: `No browser could take the screenshots (${shots.reasons.join("; ")}). ${BROWSER_REMEDY}`,
            });
          }
          const result = {
            action: "templates.snapshot",
            ok: true,
            template: rendered.template,
            fixture,
            browser: shots.browser,
            out: outDir,
            files: shots.files,
          };
          if (json) return yield* printJson(result);
          for (const file of shots.files) yield* Console.log(file.path);
        }),
      ).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
