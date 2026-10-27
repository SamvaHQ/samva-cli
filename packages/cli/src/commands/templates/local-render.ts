import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { RenderChannelResult, RenderTemplateResult } from "@samva/vite/render";
import * as Effect from "effect/Effect";

import { SamvaCliError } from "../../errors";
import type { ToolchainDiagnostic } from "./diagnostics";
import { exportProject } from "./local-export";
import {
  brandResolverPrelude,
  OPTIONS_PRELUDE,
  runToolchain,
  type ToolchainEffect,
} from "./toolchain";

export type TemplateChannelName = "email" | "sms" | "whatsapp";

export interface LocalRenderInput {
  /** A template id, or the project-relative path of its entry. */
  readonly template: string;
  readonly fixture: string;
  readonly channel: TemplateChannelName;
  readonly dir?: string | undefined;
  readonly locale?: string | undefined;
  readonly timeZone?: string | undefined;
  readonly assetBase?: string | undefined;
  readonly offline?: boolean | undefined;
}

export type LocalRenderResult = RenderTemplateResult | RenderChannelResult;

/** Render one fixture of one template through the project-installed `@samva/vite/render`. */
export const renderLocal = (input: LocalRenderInput): ToolchainEffect<LocalRenderResult> =>
  runToolchain<LocalRenderResult>({
    action: `Could not render ${input.template}`,
    options: {
      root: process.cwd(),
      template: input.template,
      fixture: input.fixture,
      channel: input.channel,
      ...(input.dir === undefined ? {} : { dir: resolve(input.dir) }),
      ...(input.locale === undefined ? {} : { locale: input.locale }),
      ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
      ...(input.assetBase === undefined ? {} : { assetBase: input.assetBase }),
      ...(input.offline === true ? { offline: true } : {}),
    },
    script: `import { renderChannel, renderTemplate } from "@samva/vite/render"; ${OPTIONS_PRELUDE}
${brandResolverPrelude()} const { channel, ...rest } = options; const result = channel === "email" ? await renderTemplate(rest) : await renderChannel({ ...rest, channel }); process.stdout.write(JSON.stringify(result));`,
  });

/** The page a snapshot screenshots, or the findings that stopped it. */
export type SnapshotPage =
  | {
      readonly ok: true;
      readonly template: string;
      readonly html: string;
      readonly diagnostics: readonly ToolchainDiagnostic[];
    }
  | { readonly ok: false; readonly diagnostics: readonly ToolchainDiagnostic[] };

const finding = (code: string, message: string): ToolchainDiagnostic => ({
  code,
  severity: "error",
  message,
  origins: [],
});

/**
 * Render one fixture to a page whose imported assets are the project's own files. Delivered
 * mail must name an HTTPS origin for its assets, which a local screenshot has no use for, so
 * this exports the project to a scratch directory and points the page at the assets written
 * beside it. The scratch directory lives as long as the caller's scope, so the page can load its
 * assets while it is screenshotted.
 */
export const renderWithProjectAssets = (input: LocalRenderInput) =>
  Effect.gen(function* () {
    const scratch = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => mkdtemp(join(tmpdir(), "samva-snapshot-export-")),
        catch: (cause) =>
          new SamvaCliError({ message: `Could not create a scratch directory: ${String(cause)}` }),
      }),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    );
    const receipt = yield* exportProject({
      dir: input.dir,
      out: scratch,
      assetBase: join(scratch, "assets"),
      offline: input.offline,
    });
    const entry = input.template.replace(/^\.\//, "");
    const template = receipt.templates.find(
      (candidate) => candidate.id === entry || candidate.entryPath === entry,
    );
    // A finding in another template's file does not stop this template's screenshot.
    const others = receipt.templates
      .filter((candidate) => candidate !== template)
      .map((candidate) => candidate.entryPath);
    const diagnostics = receipt.diagnostics.filter((diagnostic) => {
      const file = diagnostic.origins[0]?.fileName ?? "";
      return !others.some((path) => file === path || file.endsWith(`/${path}`));
    });
    if (template === undefined)
      return {
        ok: false,
        diagnostics: [
          ...diagnostics,
          finding(
            "template-not-found",
            `No template ${JSON.stringify(input.template)} in the project. Known templates: ${receipt.templates.map((candidate) => candidate.id).join(", ") || "none"}.`,
          ),
        ],
      } satisfies SnapshotPage;
    if (diagnostics.some((diagnostic) => diagnostic.severity === "error"))
      return { ok: false, diagnostics } satisfies SnapshotPage;
    const page = template.fixtures.find((candidate) => candidate.fixture === input.fixture)?.html;
    if (page === undefined)
      return {
        ok: false,
        diagnostics: [
          ...diagnostics,
          finding(
            "unknown-fixture",
            `Template ${template.id} has no email fixture ${JSON.stringify(input.fixture)}. Known fixtures: ${template.fixtures.map((candidate) => candidate.fixture).join(", ") || "none"}.`,
          ),
        ],
      } satisfies SnapshotPage;
    const html = yield* Effect.tryPromise({
      try: () => readFile(join(scratch, page), "utf8"),
      catch: (cause) =>
        new SamvaCliError({ message: `Could not read the exported page: ${String(cause)}` }),
    });
    return { ok: true, template: template.id, html, diagnostics } satisfies SnapshotPage;
  });
