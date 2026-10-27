import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as References from "effect/References";
import type { JsonValue } from "samva/effect";
import * as Email from "samva/effect/email";
import type { EmailSendInput } from "samva/effect/email";

import { CliUsageError, SamvaCliError, toCliApiError } from "../../errors";
import { readAttachments, toSendAttachments } from "../../lib/attachments";
import { getClientProvider } from "../../lib/client";
import { jsonFlag, printFields, printJson, truncateForDisplay } from "../../lib/output";
import { readStdinUtf8 } from "../../lib/stdin";
import {
  inputContractIdFlag,
  publicationIdFlag,
  resolveTemplateReference,
} from "../../lib/template-reference";
import {
  lifecycleOf,
  DEFAULT_TIMEOUT,
  durationFromFlag,
  messageLifecycleError,
  projectMessage,
  waitingLine,
  skippedRecipientsLine,
  timeoutFlag,
  waitForMessage,
} from "../messages";

/** Human status line for a definite (non-`undefined`) lifecycle outcome. */
const STATUS_LINE_BY_OUTCOME: Record<string, string> = {
  success: "Email lifecycle completed.",
  failure: "Email delivery failed.",
};

const toFlag = Flag.String("to").pipe(
  Flag.withDescription("Recipient email address (repeatable)"),
  Flag.atLeast(1),
);
const ccFlag = Flag.String("cc").pipe(
  Flag.withDescription("Cc recipient email address"),
  Flag.optional,
);
const bccFlag = Flag.String("bcc").pipe(
  Flag.withDescription("Bcc recipient email address"),
  Flag.optional,
);
const subjectFlag = Flag.String("subject").pipe(
  Flag.withDescription("Email subject line (required for inline content; omit for templates)"),
  Flag.optional,
);
const htmlFlag = Flag.String("html").pipe(
  Flag.withDescription("HTML body (use `-` to read from stdin)"),
  Flag.optional,
);
const textFlag = Flag.String("text").pipe(
  Flag.withDescription("Plain-text body (use `-` to read from stdin)"),
  Flag.optional,
);
const templateIdFlag = Flag.String("template-id").pipe(
  Flag.withDescription("Template id to render instead of inline body"),
  Flag.optional,
);
const templateSlugFlag = Flag.String("template-slug").pipe(
  Flag.withDescription("Template handle to render instead of inline body, e.g. welcome-email"),
  Flag.optional,
);
const templateDataFlag = Flag.String("template-data").pipe(
  Flag.withDescription("JSON object of variables for the template"),
  Flag.optional,
);
const localeFlag = Flag.String("locale").pipe(
  Flag.withDescription(
    "BCP 47 language tag (for example en-US) for dates, numbers and money in a template send; defaults to the template's locale",
  ),
  Flag.optional,
);
const timeZoneFlag = Flag.String("time-zone").pipe(
  Flag.withDescription(
    "IANA time zone (for example America/New_York) that a template send renders dates in; defaults to UTC",
  ),
  Flag.optional,
);
const fromFlag = Flag.String("from").pipe(
  Flag.withDescription(
    "Sender address: a verified sender or any address on a verified domain. Omitted, the send uses the default sender, else the only verified sender",
  ),
  Flag.optional,
);
const fromNameFlag = Flag.String("from-name").pipe(
  Flag.withDescription("Sender display name; applies with --from"),
  Flag.optional,
);
const replyToMessageFlag = Flag.String("reply-to-message-id").pipe(
  Flag.withDescription("Message id this email replies to (threads the conversation)"),
  Flag.optional,
);
const replyToAddressFlag = Flag.String("reply-to").pipe(
  Flag.withDescription("Reply-To header email address"),
  Flag.optional,
);
const idempotencyKeyFlag = Flag.String("idempotency-key").pipe(
  Flag.withDescription("Key (1-255 characters) so identical retries return the original email"),
  Flag.optional,
);
const trackOpensFlag = Flag.Literals("track-opens", ["on", "off"]).pipe(
  Flag.withDescription("Override open tracking for this send; recipient opt-out still wins"),
  Flag.optional,
);
const trackClicksFlag = Flag.Literals("track-clicks", ["on", "off"]).pipe(
  Flag.withDescription("Override click tracking for this send; recipient opt-out still wins"),
  Flag.optional,
);
const attachFlag = Flag.String("attach").pipe(
  Flag.withDescription(
    "File to attach (repeatable); small files travel inline, larger ones upload through media first",
  ),
  Flag.atLeast(0),
);
const headerFlag = Flag.String("header").pipe(
  Flag.withDescription("Custom email header as Name: Value (repeatable)"),
  Flag.withMetavar("Name: Value"),
  Flag.atLeast(0),
);
const dryRunFlag = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Validate inputs and print the request payload without calling the API"),
  Flag.withDefault(false),
);

type SendRequestBody = Omit<EmailSendInput, "to"> & {
  readonly to: Extract<EmailSendInput["to"], ReadonlyArray<unknown>>;
};

type BodySource = "html" | "text" | "stdin" | "template";

const bodySourceName = (input: {
  readonly templateRefValue: string | undefined;
  readonly resolvedHtml: string | undefined;
  readonly stdin: boolean;
}): BodySource => {
  if (input.templateRefValue) return "template";
  if (input.stdin) return "stdin";
  if (input.resolvedHtml) return "html";
  return "text";
};

/** Reserved names and size limits belong to the API. */
const emailHeader = (raw: string): Effect.Effect<readonly [string, string], CliUsageError> => {
  const separator = raw.indexOf(":");
  const name = separator === -1 ? "" : raw.slice(0, separator).trim();
  const value = separator === -1 ? "" : raw.slice(separator + 1).trim();
  if (name.length === 0 || value.length === 0) {
    return Effect.fail(
      new CliUsageError({
        code: "email_header_malformed",
        message: `--header expects Name: Value, got ${raw}.`,
      }),
    );
  }
  return Effect.succeed([name, value]);
};

const parseTemplateData = (
  raw: Option.Option<string>,
): Effect.Effect<{ readonly [x: string]: JsonValue } | undefined, SamvaCliError> =>
  Option.match(raw, {
    // @effect-diagnostics-next-line effectSucceedWithVoid:off -- undefined is a real success value (no template data), not a void outcome; Effect.void is not assignable to the `... | undefined` return.
    onNone: () => Effect.succeed(undefined),
    onSome: (value) =>
      Effect.try({
        try: () => JSON.parse(value) as unknown,
        catch: () => new SamvaCliError({ message: "--template-data must be a JSON object." }),
      }).pipe(
        Effect.flatMap((parsed) =>
          Predicate.isObject(parsed)
            ? Effect.succeed(parsed as { readonly [x: string]: JsonValue })
            : Effect.fail(new SamvaCliError({ message: "--template-data must be a JSON object." })),
        ),
      ),
  });

export const send = Command.make("send", {
  to: toFlag,
  cc: ccFlag,
  bcc: bccFlag,
  subject: subjectFlag,
  html: htmlFlag,
  text: textFlag,
  topicId: Flag.String("topic-id").pipe(
    Flag.withDescription("Topic whose subscription preference this send honors"),
    Flag.optional,
  ),
  templateId: templateIdFlag,
  publicationId: publicationIdFlag,
  inputContractId: inputContractIdFlag,
  templateSlug: templateSlugFlag,
  templateData: templateDataFlag,
  locale: localeFlag,
  timeZone: timeZoneFlag,
  from: fromFlag,
  fromName: fromNameFlag,
  replyTo: replyToMessageFlag,
  replyToAddress: replyToAddressFlag,
  idempotencyKey: idempotencyKeyFlag,
  trackOpens: trackOpensFlag,
  trackClicks: trackClicksFlag,
  attach: attachFlag,
  header: headerFlag,
  dryRun: dryRunFlag,
  wait: Flag.Boolean("wait").pipe(
    Flag.withDescription("Wait for delivered/read or a terminal delivery failure"),
    Flag.withDefault(false),
  ),
  timeout: timeoutFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Send an email"),
  Command.withExamples([
    {
      command: "samva email send --to you@example.com --subject Hi --text Hello",
      description: "Plain-text body (SAMVA_API_KEY)",
    },
    {
      command:
        'samva email send --to you@example.com --template-slug welcome-email --template-data \'{"name":"Ada"}\'',
      description: "Render a template by handle",
    },
    {
      command:
        "samva email send --to you@example.com --template-slug order-receipt --template-data '{\"total\":42}' --locale de-DE --time-zone Europe/Berlin",
      description: "Render a template's dates and money for a locale and time zone",
    },
    {
      command:
        "samva email send --to you@example.com --subject Hi --text Hello --from hello@acme.test",
      description: "Send from any address on a verified domain, or from a verified sender",
    },
    {
      command: 'echo "Hello" | samva email send --to you@example.com --subject Hi --text -',
      description: "Pipe plain-text body from stdin",
    },
    {
      command: "samva email send --to you@example.com --subject Hi --text Hello --dry-run",
      description: "Validate and print the request payload without sending",
    },
    {
      command:
        "samva email send --to you@example.com --subject Hi --text Hello --idempotency-key welcome-email-ada",
      description: "Retry a send safely with an idempotency key",
    },
    {
      command:
        "samva email send --to you@example.com --subject Report --text Attached --attach ./report.pdf --attach ./data.csv",
      description:
        "Attach files; those past the 4 MiB inline limit upload through media automatically",
    },
    {
      command:
        "samva email send --to you@example.com --subject Hi --text Hello --header 'OTP-Token: 123456'",
      description: "Copy a custom header onto the message",
    },
  ]),
  Command.withHandler(
    ({
      to,
      cc,
      bcc,
      subject,
      html,
      text,
      topicId,
      templateId,
      publicationId,
      inputContractId,
      templateSlug,
      templateData,
      locale,
      timeZone,
      from,
      fromName,
      replyTo,
      replyToAddress,
      idempotencyKey,
      trackOpens,
      trackClicks,
      attach,
      header,
      dryRun,
      wait,
      timeout,
      json,
    }) =>
      Effect.gen(function* () {
        const subjectValue = Option.getOrUndefined(subject);
        const htmlValue = Option.getOrUndefined(html);
        const textValue = Option.getOrUndefined(text);
        const templateIdValue = Option.getOrUndefined(templateId);
        const templateSlugValue = Option.getOrUndefined(templateSlug);
        const reference = yield* resolveTemplateReference({
          templateId: templateIdValue,
          publicationId: Option.getOrUndefined(publicationId),
          inputContractId: Option.getOrUndefined(inputContractId),
        });
        const fromValue = Option.getOrUndefined(from);
        const fromNameValue = Option.getOrUndefined(fromName);
        if (fromValue === undefined && fromNameValue !== undefined) {
          return yield* new SamvaCliError({ message: "--from-name applies with --from." });
        }
        const replyToValue = Option.getOrUndefined(replyTo);
        const replyToAddressValue = Option.getOrUndefined(replyToAddress);
        const idempotencyKeyValue = Option.getOrUndefined(idempotencyKey);
        const trackOpensValue = Option.getOrUndefined(trackOpens);
        const trackClicksValue = Option.getOrUndefined(trackClicks);
        const ccValue = Option.getOrUndefined(cc);
        const bccValue = Option.getOrUndefined(bcc);
        const templateDataValue = yield* parseTemplateData(templateData);
        const localeValue = Option.getOrUndefined(locale);
        const timeZoneValue = Option.getOrUndefined(timeZone);

        if (
          idempotencyKeyValue !== undefined &&
          (idempotencyKeyValue.length < 1 || idempotencyKeyValue.length > 255)
        ) {
          return yield* new SamvaCliError({
            message: "--idempotency-key must contain between 1 and 255 characters.",
          });
        }

        if (templateIdValue && templateSlugValue) {
          return yield* new SamvaCliError({
            message: "Use either --template-id or --template-slug, not both.",
          });
        }
        const templateRefValue = templateSlugValue ?? templateIdValue;

        if (
          (localeValue !== undefined || timeZoneValue !== undefined) &&
          !templateIdValue &&
          !templateSlugValue
        ) {
          return yield* new SamvaCliError({
            message: "--locale and --time-zone apply to template sends.",
          });
        }
        if (templateRefValue && subjectValue) {
          return yield* new SamvaCliError({
            message: "Template sends derive their subject from the template. Omit --subject.",
          });
        }
        if (!templateRefValue && !subjectValue) {
          return yield* new CliUsageError({
            code: "missing_subject",
            message:
              "Inline email content requires --subject. Run `samva email send --help` for examples.",
          });
        }

        if (textValue === "-" && htmlValue === "-") {
          return yield* new CliUsageError({
            code: "multiple_stdin_bodies",
            message: "Only one body can be read from stdin: use --text - or --html -, not both.",
          });
        }
        const resolvedText = textValue === "-" ? yield* readStdinUtf8 : textValue;
        const resolvedHtml = htmlValue === "-" ? yield* readStdinUtf8 : htmlValue;

        if (!resolvedHtml && !resolvedText && !templateRefValue) {
          return yield* new SamvaCliError({
            message:
              "Provide a body: one of --html, --text (or --text - for stdin), --template-id, or --template-slug.",
          });
        }
        const bodyFlagCount = [resolvedHtml, resolvedText, templateRefValue].filter(Boolean).length;
        if (bodyFlagCount > 1) {
          return yield* new SamvaCliError({
            message:
              "Choose exactly one body source: --html, --text, or a template (--template-id/--template-slug).",
          });
        }

        // Every file is read and budget-checked before any request, dry runs included.
        const attachmentFiles = yield* readAttachments(attach);
        const headers: { [name: string]: string } = Object.create(null);
        for (const raw of header) {
          const [name, value] = yield* emailHeader(raw);
          headers[name] = value;
        }

        const request: SendRequestBody = {
          to: [...to],
          ...(ccValue ? { cc: [{ email: ccValue }] } : {}),
          ...(bccValue ? { bcc: [{ email: bccValue }] } : {}),
          ...(subjectValue === undefined ? {} : { subject: subjectValue }),
          ...(resolvedHtml === undefined ? {} : { html: resolvedHtml }),
          ...(resolvedText === undefined ? {} : { text: resolvedText }),
          ...(Option.isSome(topicId) ? { topicId: topicId.value } : {}),
          ...(templateIdValue === undefined ? {} : { templateId: templateIdValue }),
          ...reference,
          ...(templateSlugValue === undefined ? {} : { templateSlug: templateSlugValue }),
          ...(templateDataValue === undefined ? {} : { templateData: templateDataValue }),
          ...(localeValue === undefined ? {} : { locale: localeValue }),
          ...(timeZoneValue === undefined ? {} : { timeZone: timeZoneValue }),
          ...(fromValue === undefined
            ? {}
            : {
                from: {
                  email: fromValue,
                  ...(fromNameValue === undefined ? {} : { name: fromNameValue }),
                },
              }),
          ...(replyToValue === undefined ? {} : { inReplyToMessageId: replyToValue }),
          ...(replyToAddressValue === undefined ? {} : { replyTo: replyToAddressValue }),
          ...(trackOpensValue !== undefined || trackClicksValue !== undefined
            ? {
                tracking: {
                  ...(trackOpensValue !== undefined ? { opens: trackOpensValue === "on" } : {}),
                  ...(trackClicksValue !== undefined ? { clicks: trackClicksValue === "on" } : {}),
                },
              }
            : {}),
          ...(Object.keys(headers).length === 0 ? {} : { headers }),
        };
        // An explicit key overrides the SDK's per-call auto-generated
        // Idempotency-Key; omitted, the facade generates one.
        const sendOptions =
          idempotencyKeyValue !== undefined ? { idempotencyKey: idempotencyKeyValue } : {};
        const source = bodySourceName({
          templateRefValue,
          resolvedHtml,
          stdin: textValue === "-" || htmlValue === "-",
        });

        if (dryRun && wait) {
          return yield* new CliUsageError({
            code: "dry_run_wait_conflict",
            message:
              "--wait cannot be combined with --dry-run; a dry run sends nothing to wait on.",
          });
        }
        if (!wait && Option.isSome(timeout)) {
          return yield* new CliUsageError({
            code: "timeout_requires_wait",
            message: "--timeout is meaningful only with --wait.",
          });
        }
        const waitDuration = wait
          ? yield* durationFromFlag(Option.getOrElse(timeout, () => DEFAULT_TIMEOUT))
          : undefined;

        if (dryRun) {
          if (json) {
            return yield* printJson({
              dryRun: true,
              bodySource: source,
              request: {
                ...request,
                ...(attachmentFiles.length === 0
                  ? {}
                  : {
                      attachments: attachmentFiles.map((file) => ({
                        filename: file.filename,
                        contentType: file.contentType,
                        size: file.bytes.length,
                      })),
                    }),
              },
              idempotencyKey: idempotencyKeyValue,
            });
          }

          yield* Effect.logInfo(
            "Dry run — no credentials, configuration, DNS, or API request used.",
          );
          yield* printFields([["Body source", source]]);
          yield* Console.log("");
          yield* printFields([
            ...(request.from ? [["From", request.from.email] as const] : []),
            ["To", request.to.join(", ")],
            ...(ccValue ? [["Cc", ccValue] as const] : []),
            ...(bccValue ? [["Bcc", bccValue] as const] : []),
            ["Subject", request.subject],
            ...(request.templateSlug
              ? [["Template", `${request.templateSlug} (handle)`] as const]
              : request.templateId
                ? [["Template", request.templateId] as const]
                : []),
            ...(request.inReplyToMessageId
              ? [["Reply to", request.inReplyToMessageId] as const]
              : []),
            ...(request.replyTo ? [["Reply-To", request.replyTo] as const] : []),
            ...Object.entries(request.headers ?? {}).map(
              ([name, value]) => ["Header", `${name}: ${value}`] as const,
            ),
            ...(idempotencyKeyValue ? [["Idempotency key", idempotencyKeyValue] as const] : []),
            ...attachmentFiles.map(
              (file) =>
                [
                  "Attachment",
                  `${file.filename} (${file.contentType}, ${file.bytes.length} bytes)`,
                ] as const,
            ),
            ...(request.tracking
              ? ([
                  ["Track opens", request.tracking.opens],
                  ["Track clicks", request.tracking.clicks],
                ] as const)
              : []),
          ]);
          if (request.text) {
            yield* Console.log(
              `\nText body (${request.text.length} chars):\n${truncateForDisplay(request.text)}`,
            );
          }
          if (request.html) {
            yield* Console.log(
              `\nHTML body (${request.html.length} chars):\n${truncateForDisplay(request.html)}`,
            );
          }
          if (request.templateData) {
            yield* Console.log(
              `\nTemplate data:\n${truncateForDisplay(JSON.stringify(request.templateData, null, 2))}`,
            );
          }
          return;
        }

        const client = yield* getClientProvider;
        const attachments = toSendAttachments(attachmentFiles);
        const data = yield* Email.send(
          { ...request, ...(attachments.length === 0 ? {} : { attachments }) },
          sendOptions,
        ).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError("Failed to send email", error)),
        );
        const finalMessage =
          waitDuration === undefined ? data : yield* waitForMessage(data, waitDuration);
        const projection = projectMessage(finalMessage);
        // Classify before printing so the human status line reflects the real
        // outcome — a timeout must not be announced as a completed lifecycle.
        const outcome = wait ? lifecycleOf(finalMessage) : undefined;
        if (outcome === "pending") {
          return yield* messageLifecycleError(
            "message_wait_timeout",
            `Timed out waiting for message ${projection.id}; it remains ${projection.status}.`,
            projection,
          );
        }
        if (outcome === "failure") {
          return yield* messageLifecycleError(
            "message_terminal_failure",
            `Message ${projection.id} reached terminal status ${projection.status}.`,
            projection,
          );
        }
        if (json) yield* printJson(projection);
        else {
          const statusLine =
            outcome === undefined
              ? "Email queued."
              : (STATUS_LINE_BY_OUTCOME[outcome] ?? "Email delivery timed out.");
          yield* Effect.logInfo(`${statusLine}\n`);
          yield* printFields([
            ["Message ID", projection.id],
            ["Status", projection.status],
            ["Waiting", waitingLine(projection)],
            ["Skipped", skippedRecipientsLine(projection)],
          ]);
        }
      }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
