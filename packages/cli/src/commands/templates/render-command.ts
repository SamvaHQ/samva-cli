import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { formatReportedDiagnostic } from "@samva/core/shared/template-diagnostics";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as References from "effect/References";

import { CliResultError, SamvaCliError } from "../../errors";
import { jsonFlag, printJsonDocument } from "../../lib/output";
import { reportDiagnostic } from "./diagnostics";
import { assetBaseFlag, dirFlag, offlineFlag } from "./flags";
import { type LocalRenderResult, renderLocal, type TemplateChannelName } from "./local-render";

type RenderFormat = "text" | "html" | "json";

/** The `--json` payload of `templates render`: the render result with normalized findings. */
const renderPayload = (result: LocalRenderResult, out: string | undefined) => ({
  action: "templates.render",
  ...result,
  diagnostics: result.diagnostics.map((diagnostic) => reportDiagnostic(diagnostic, { file: "." })),
  ...(out === undefined ? {} : { out }),
});

/** What the human formats print: an email's subject, preheader and body; a channel's message. */
const renderedBody = (result: LocalRenderResult & { readonly ok: true }, format: RenderFormat) => {
  if ("html" in result) {
    if (format === "html") return result.html;
    return [
      `Subject: ${result.subject}`,
      ...(result.preheader === undefined ? [] : [`Preheader: ${result.preheader}`]),
      "",
      result.text,
    ].join("\n");
  }
  if ("message" in result) {
    const { header, body, footer, buttons } = result.message;
    return [
      ...(header === undefined ? [] : [`Header (${header.type}): ${header.text}`, ""]),
      body,
      ...(footer === undefined ? [] : ["", footer]),
      ...(buttons.length === 0
        ? []
        : ["", ...buttons.map((button) => `[${JSON.stringify(button)}]`)]),
    ].join("\n");
  }
  return result.text;
};

export const renderCommand = Command.make("render", {
  template: Argument.String("template").pipe(
    Argument.withDescription("Template id, or the path of its .tsx entry"),
  ),
  fixture: Flag.String("fixture").pipe(
    Flag.withDescription("Fixture to render, such as no-tracking"),
  ),
  channel: Flag.Literals("channel", ["email", "sms", "whatsapp"] as const).pipe(
    Flag.withDescription("Channel to render"),
    Flag.withDefault("email" as TemplateChannelName),
  ),
  dir: dirFlag,
  locale: Flag.String("locale").pipe(
    Flag.withDescription("Locale for formatters (default: the template's)"),
    Flag.optional,
  ),
  timeZone: Flag.String("time-zone").pipe(
    Flag.withDescription("IANA time zone for date and time formatters (default: UTC)"),
    Flag.optional,
  ),
  assetBase: assetBaseFlag,
  offline: offlineFlag,
  format: Flag.Literals("format", ["text", "html", "json"] as const).pipe(
    Flag.withDescription(
      "text: subject, preheader and plain-text body; html: the HTML; json: the full result",
    ),
    Flag.withDefault("text" as RenderFormat),
  ),
  out: Flag.File("out").pipe(
    Flag.withDescription("Write the rendered output to a file instead of stdout"),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Render one fixture of a local template and print the result"),
  Command.withExamples([
    {
      command: "samva templates render welcome --fixture no-tracking",
      description: "Print the subject, preheader and plain-text body",
    },
    {
      command: "samva templates render welcome --fixture default --format html --out welcome.html",
      description: "Write the rendered HTML to a file",
    },
    {
      command: "samva templates render welcome --fixture default --json",
      description: "Print the full result with located findings, fixes and edits",
    },
    {
      command: "samva templates render order-shipped --fixture default --channel sms",
      description: "Render the SMS body of a multi-channel template",
    },
  ]),
  Command.withHandler(
    ({
      template,
      fixture,
      channel,
      dir,
      locale,
      timeZone,
      assetBase,
      offline,
      format,
      out,
      json,
    }) =>
      Effect.gen(function* () {
        const machine = json || format === "json";
        const outPath = Option.map(out, (value) => resolve(value)).pipe(Option.getOrUndefined);
        const result = yield* renderLocal({
          template,
          fixture,
          channel,
          dir: Option.getOrUndefined(dir),
          locale: Option.getOrUndefined(locale),
          timeZone: Option.getOrUndefined(timeZone),
          assetBase: Option.getOrUndefined(assetBase),
          offline,
        });
        if (!result.ok) {
          const message = `Could not render ${template} (${fixture}): ${result.diagnostics.length} finding(s).`;
          if (machine) {
            return yield* new CliResultError({
              code: "template_render_failed",
              message,
              result: renderPayload(result, undefined),
              human: message,
            });
          }
          for (const diagnostic of result.diagnostics) {
            yield* Console.error(
              formatReportedDiagnostic(reportDiagnostic(diagnostic, { file: "." })),
            );
          }
          return yield* new SamvaCliError({ message });
        }
        const payload = renderPayload(result, outPath);
        if (outPath !== undefined) {
          const content = machine
            ? `${JSON.stringify(payload, null, 2)}\n`
            : `${renderedBody(result, format)}\n`;
          yield* Effect.tryPromise({
            try: async () => {
              await mkdir(dirname(outPath), { recursive: true });
              await writeFile(outPath, content);
            },
            catch: (cause) =>
              new SamvaCliError({ message: `Could not write ${outPath}: ${String(cause)}` }),
          });
        }
        // `--format json` selects JSON as the render format without selecting a machine output mode,
        // so the payload is a JSON document in either case.
        if (machine) return yield* printJsonDocument(payload);
        for (const diagnostic of result.diagnostics) {
          yield* Console.error(
            formatReportedDiagnostic(reportDiagnostic(diagnostic, { file: "." })),
          );
        }
        if (outPath !== undefined) return yield* Effect.logInfo(`Wrote ${outPath}`);
        yield* Console.log(renderedBody(result, format));
      }).pipe(
        json || format === "json"
          ? Effect.provideService(References.MinimumLogLevel, "None")
          : identity,
      ),
  ),
);
