import { forStage } from "@samva/core/shared/hostnames";
import type { ReportedDiagnostic } from "@samva/core/shared/template-diagnostics";
import type { BuildTemplatesResult } from "@samva/vite/build";

/**
 * A compiler finding as `@samva/vite` reports it. The compiler may attach `fix` (what to write
 * instead), `upgrade` (how to migrate a template written in a format the compiler rejects), `range` (the
 * located source extent) and `edit` (a machine-applicable change); a finding that carries none of
 * them still has its code, severity, message and origin.
 */
export type ToolchainDiagnostic = BuildTemplatesResult["diagnostics"][number] & {
  readonly fix?: string | undefined;
  readonly upgrade?: string | undefined;
  readonly range?: unknown;
  readonly edit?: unknown;
};

/** The origin a published template's imported assets are served from. */
const PUBLISHED_ASSET_BASE = `https://${forStage("production").cdn}`;

/**
 * What to do about a finding whose compiler fix assumes context a local command lacks: the
 * compiler cannot know where a Samva project's assets are served from, or that a file it was
 * asked about is a partial rather than a template.
 */
const localFix = (diagnostic: ToolchainDiagnostic): string | undefined => {
  switch (diagnostic.code) {
    case "missing-asset-base":
      return `Pass --asset-base with the HTTPS origin that serves the imported files. Samva hosts the assets of a published template at ${PUBLISHED_ASSET_BASE}, so \`--asset-base ${PUBLISHED_ASSET_BASE}\` checks a Samva project as it publishes.`;
    case "no-template":
      return `${diagnostic.fix ?? "Default-export defineTemplate({ ... })."} A partial such as a file under templates/blocks/ is not a template: render a template that imports it, and fix this file's other findings.`;
    default:
      return diagnostic.fix;
  }
};

/** Normalize a compiler finding; `file` is used when the finding names no origin. */
export const reportDiagnostic = (
  diagnostic: ToolchainDiagnostic,
  context: { readonly file: string; readonly fixture?: string | undefined },
): ReportedDiagnostic => {
  const origin = diagnostic.origins[0];
  const fix = localFix(diagnostic);
  const range =
    diagnostic.range ??
    (origin === undefined
      ? undefined
      : { start: { line: origin.lineNumber, column: origin.columnNumber } });
  return {
    file: origin?.fileName ?? context.file,
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(origin === undefined ? {} : { line: origin.lineNumber, column: origin.columnNumber }),
    ...(range === undefined ? {} : { range }),
    ...(fix === undefined ? {} : { fix }),
    ...(diagnostic.upgrade === undefined ? {} : { upgrade: diagnostic.upgrade }),
    ...(diagnostic.edit === undefined ? {} : { edit: diagnostic.edit }),
    ...(context.fixture === undefined ? {} : { fixture: context.fixture }),
  };
};
