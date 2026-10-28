import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as References from "effect/References";
import type { JsonValue } from "samva/effect";
import * as ScheduledMessages from "samva/effect/scheduled-messages";

import { CliUsageError, SamvaCliError, toCliApiError } from "../errors";
import { getClientProvider } from "../lib/client";
import { confirmDestructive } from "../lib/confirm";
import { jsonFlag, printFields, printJson, printJsonLine, truncateForDisplay } from "../lib/output";
import { isJsonLinesRequested } from "../lib/runtime";
import {
  inputContractIdFlag,
  publicationIdFlag,
  resolveTemplateReference,
} from "../lib/template-reference";

type JsonRecord = { readonly [x: string]: JsonValue };

/** Ergonomic input for `ScheduledMessages.create`, derived from the SDK facade. */
type ScheduledMessagesCreateRequestJson = Parameters<typeof ScheduledMessages.create>[0];

const SCHEDULED_STATUSES = [
  "pending",
  "paused",
  "dispatching",
  "dispatched",
  "cancelled",
  "failed",
] as const;
const ABSOLUTE_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const isAbsoluteInstant = (value: string): boolean => {
  const match = ABSOLUTE_INSTANT_PATTERN.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  return (
    calendarDate.getUTCFullYear() === year &&
    calendarDate.getUTCMonth() === month - 1 &&
    calendarDate.getUTCDate() === day
  );
};

/** Clean inputs for a scheduled email send, already resolved from flags. */
export interface ScheduledEmailCreateInput {
  readonly to: ReadonlyArray<string>;
  readonly subject: string | undefined;
  readonly html: string | undefined;
  readonly text: string | undefined;
  readonly topicId?: string | undefined;
  readonly templateId: string | undefined;
  readonly publicationId: string | undefined;
  readonly inputContractId: string | undefined;
  readonly templateSlug: string | undefined;
  readonly templateData: JsonRecord | undefined;
  readonly cc: string | undefined;
  readonly bcc: string | undefined;
  readonly from?: { readonly email: string; readonly name?: string } | undefined;
  readonly scheduledFor: Date;
  readonly timezone: string | undefined;
  readonly referenceId: string | undefined;
  readonly tracking: { readonly opens?: boolean; readonly clicks?: boolean } | undefined;
}

/**
 * Assemble the `scheduledMessages.create` email payload from resolved flags.
 * Pure so the flag-to-request mapping can be unit-tested without the network.
 */
export const assembleScheduledEmailPayload = (
  input: ScheduledEmailCreateInput,
): ScheduledMessagesCreateRequestJson => ({
  send: {
    channel: "email",
    to: input.to.map((email) => ({ email })),
    cc: input.cc ? [{ email: input.cc }] : undefined,
    bcc: input.bcc ? [{ email: input.bcc }] : undefined,
    ...(input.from === undefined ? {} : { from: input.from }),
    email: {
      ...(input.topicId === undefined ? {} : { topicId: input.topicId }),
      subject: input.subject,
      html: input.html,
      text: input.text,
      templateId: input.templateId,
      ...(input.publicationId === undefined ? {} : { publicationId: input.publicationId }),
      ...(input.inputContractId === undefined ? {} : { inputContractId: input.inputContractId }),
      templateSlug: input.templateSlug,
      templateData: input.templateData,
      ...(input.tracking === undefined ? {} : { tracking: input.tracking }),
    },
  },
  scheduledFor: input.scheduledFor,
  timezone: input.timezone,
  referenceId: input.referenceId,
});

const parseTemplateData = (
  raw: Option.Option<string>,
): Effect.Effect<JsonRecord | undefined, SamvaCliError> =>
  Option.match(raw, {
    // @effect-diagnostics-next-line effectSucceedWithVoid:off -- undefined is a real success value (no template data), not a void outcome; Effect.void is not assignable to `JsonRecord | undefined`.
    onNone: () => Effect.succeed(undefined),
    onSome: (value) =>
      Effect.try({
        try: () => JSON.parse(value) as unknown,
        catch: () => new SamvaCliError({ message: "--template-data must be a JSON object." }),
      }).pipe(
        Effect.flatMap((parsed) =>
          Predicate.isObject(parsed)
            ? Effect.succeed(parsed as JsonRecord)
            : Effect.fail(new SamvaCliError({ message: "--template-data must be a JSON object." })),
        ),
      ),
  });

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
const subjectFlag = Flag.String("subject").pipe(
  Flag.withDescription("Email subject line (required with inline --html; omit for templates)"),
  Flag.optional,
);
const htmlFlag = Flag.String("html").pipe(Flag.withDescription("HTML body"), Flag.optional);
const textFlag = Flag.String("text").pipe(Flag.withDescription("Plain-text body"), Flag.optional);
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
const atFlag = Flag.String("at").pipe(
  Flag.withDescription("Absolute send instant as an ISO 8601 datetime, e.g. 2026-08-01T09:00:00Z"),
);
const timezoneFlag = Flag.String("timezone").pipe(
  Flag.withDescription("IANA timezone for the schedule, e.g. America/New_York"),
  Flag.optional,
);
const idempotencyKeyFlag = Flag.String("idempotency-key").pipe(
  Flag.withDescription("Idempotency key so retries do not schedule duplicates"),
  Flag.optional,
);
const referenceIdFlag = Flag.String("reference-id").pipe(
  Flag.withDescription("Your own reference id to correlate this schedule"),
  Flag.optional,
);
const dryRunFlag = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Validate inputs and print the request payload without calling the API"),
  Flag.withDefault(false),
);
const trackOpensFlag = Flag.Literals("track-opens", ["on", "off"]).pipe(
  Flag.withDescription("Override open tracking for this scheduled send; recipient opt-out wins"),
  Flag.optional,
);
const trackClicksFlag = Flag.Literals("track-clicks", ["on", "off"]).pipe(
  Flag.withDescription("Override click tracking for this scheduled send; recipient opt-out wins"),
  Flag.optional,
);
const statusFlag = Flag.Literals("status", SCHEDULED_STATUSES).pipe(
  Flag.withDescription("Filter by status"),
  Flag.optional,
);
const cursorFlag = Flag.String("cursor").pipe(
  Flag.withDescription("Resume after this nextCursor from a previous page"),
  Flag.optional,
);
const limitFlag = Flag.Int("limit").pipe(Flag.withDescription("Items per page"), Flag.optional);
const allFlag = Flag.Boolean("all").pipe(
  Flag.withDescription("Traverse every page (requires --jsonl)"),
  Flag.withDefault(false),
);

const create = Command.make("create", {
  to: toFlag,
  cc: ccFlag,
  bcc: bccFlag,
  from: fromFlag,
  fromName: fromNameFlag,
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
  at: atFlag,
  timezone: timezoneFlag,
  idempotencyKey: idempotencyKeyFlag,
  referenceId: referenceIdFlag,
  trackOpens: trackOpensFlag,
  trackClicks: trackClicksFlag,
  dryRun: dryRunFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Schedule an email to send at a future time"),
  Command.withExamples([
    {
      command:
        'samva scheduled-messages create --to you@example.com --subject Hi --html "<p>Hello</p>" --text Hello --at 2026-08-01T09:00:00Z',
      description: "Schedule an inline HTML email with a text fallback",
    },
    {
      command:
        'samva scheduled-messages create --to you@example.com --from hello@acme.test --subject Hi --html "<p>Hello</p>" --at 2026-08-01T09:00:00Z',
      description: "Send from any address on a verified domain, or from a verified sender",
    },
    {
      command:
        'samva scheduled-messages create --to you@example.com --template-slug welcome-email --template-data \'{"name":"Ada"}\' --at 2026-08-01T09:00:00Z --timezone America/New_York',
      description: "Schedule a published template; timezone is descriptive metadata",
    },
    {
      command:
        'samva scheduled-messages create --to you@example.com --subject Hi --html "<p>Hello</p>" --at 2026-08-01T09:00:00Z --dry-run',
      description: "Validate and print the payload without scheduling",
    },
  ]),
  Command.withHandler(
    ({
      to,
      cc,
      bcc,
      from,
      fromName,
      subject,
      html,
      text,
      topicId,
      templateId,
      publicationId,
      inputContractId,
      templateSlug,
      templateData,
      at,
      timezone,
      idempotencyKey,
      referenceId,
      trackOpens,
      trackClicks,
      dryRun,
      json,
    }) =>
      Effect.gen(function* () {
        const htmlValue = Option.getOrUndefined(html);
        const textValue = Option.getOrUndefined(text);
        const templateIdValue = Option.getOrUndefined(templateId);
        const reference = yield* resolveTemplateReference({
          templateId: templateIdValue,
          publicationId: Option.getOrUndefined(publicationId),
          inputContractId: Option.getOrUndefined(inputContractId),
        });
        const templateSlugValue = Option.getOrUndefined(templateSlug);
        const templateDataValue = yield* parseTemplateData(templateData);
        const fromValue = Option.getOrUndefined(from);
        const fromNameValue = Option.getOrUndefined(fromName);
        if (fromValue === undefined && fromNameValue !== undefined) {
          return yield* new SamvaCliError({ message: "--from-name applies with --from." });
        }

        if (templateIdValue && templateSlugValue) {
          return yield* new SamvaCliError({
            message: "Use either --template-id or --template-slug, not both.",
          });
        }
        const templateRefValue = templateSlugValue ?? templateIdValue;

        if (templateRefValue && (Option.isSome(subject) || htmlValue || textValue)) {
          return yield* new SamvaCliError({
            message:
              "Choose one content source: a template, or inline --subject with --html (and optional --text).",
          });
        }
        if (!templateRefValue && Option.isNone(subject)) {
          return yield* new SamvaCliError({
            message: "Provide --subject with inline --html, or reference a published template.",
          });
        }
        if (!templateRefValue && !htmlValue) {
          return yield* new SamvaCliError({
            message:
              "Provide --html for inline email; --text is an optional fallback, not a body source.",
          });
        }

        if (!isAbsoluteInstant(at)) {
          return yield* new SamvaCliError({
            message:
              "--at must be an absolute ISO 8601 instant with Z or an offset, e.g. 2026-08-01T09:00:00Z.",
          });
        }

        const payload = assembleScheduledEmailPayload({
          to: [...to],
          subject: Option.getOrUndefined(subject),
          html: htmlValue,
          text: textValue,
          topicId: Option.getOrUndefined(topicId),
          templateId: templateIdValue,
          publicationId: reference.publicationId,
          inputContractId: reference.inputContractId,
          templateSlug: templateSlugValue,
          templateData: templateDataValue,
          cc: Option.getOrUndefined(cc),
          bcc: Option.getOrUndefined(bcc),
          ...(fromValue === undefined
            ? {}
            : {
                from: {
                  email: fromValue,
                  ...(fromNameValue === undefined ? {} : { name: fromNameValue }),
                },
              }),
          scheduledFor: new Date(at),
          timezone: Option.getOrUndefined(timezone),
          referenceId: Option.getOrUndefined(referenceId),
          tracking:
            Option.isSome(trackOpens) || Option.isSome(trackClicks)
              ? {
                  ...(Option.isSome(trackOpens) ? { opens: trackOpens.value === "on" } : {}),
                  ...(Option.isSome(trackClicks) ? { clicks: trackClicks.value === "on" } : {}),
                }
              : undefined,
        });

        if (dryRun) {
          if (json) return yield* printJson({ dryRun: true, request: payload });
          yield* Effect.logInfo("Dry run — no schedule created.\n");
          yield* printFields([
            ["To", [...to].join(", ")],
            ["Subject", Option.getOrUndefined(subject)],
            ["Send at", at],
            ["Timezone", Option.getOrUndefined(timezone)],
          ]);
          return yield* Console.log(
            `\nPayload:\n${truncateForDisplay(JSON.stringify(payload, null, 2))}`,
          );
        }

        const client = yield* getClientProvider;
        const data = yield* ScheduledMessages.create(payload, {
          idempotencyKey: Option.getOrUndefined(idempotencyKey),
        }).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError("Failed to schedule message", error)),
        );
        if (json) return yield* printJson(data);
        yield* Effect.logInfo("Message scheduled.\n");
        yield* printFields([
          ["ID", data.id],
          ["Status", data.status],
          ["Send at", data.scheduledFor],
          ["Timezone", data.timezone],
        ]);
        yield* Effect.logInfo(`\nInspect it:  samva scheduled-messages get ${data.id}`);
      }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const list = Command.make("list", {
  status: statusFlag,
  cursor: cursorFlag,
  limit: limitFlag,
  all: allFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List scheduled messages"),
  Command.withExamples([
    { command: "samva scheduled-messages list", description: "List all scheduled messages" },
    {
      command: "samva scheduled-messages list --status pending",
      description: "Only pending schedules",
    },
    { command: "samva scheduled-messages list --json" },
    {
      command: "samva scheduled-messages list --all --jsonl",
      description: "Stream every page as JSONL",
    },
  ]),
  Command.withHandler(({ status, cursor, limit, all, json }) =>
    Effect.gen(function* () {
      if (all && !isJsonLinesRequested()) {
        return yield* new CliUsageError({
          code: "all_requires_jsonl",
          message: "--all is an unbounded traversal and requires --jsonl.",
        });
      }
      const cursorValue = Option.getOrUndefined(cursor);
      const limitValue = Option.getOrUndefined(limit);
      const client = yield* getClientProvider;
      const query = {
        status: Option.getOrUndefined(status),
        cursor: cursorValue,
        limit: limitValue,
      };
      if (all) {
        let nextCursor = cursorValue;
        for (;;) {
          const data = yield* ScheduledMessages.list({ ...query, cursor: nextCursor }).pipe(
            client.provide,
            Effect.mapError((error) => toCliApiError("Could not list scheduled messages", error)),
          );
          for (const item of data.items) yield* printJsonLine(item);
          if (data.nextCursor === null) return;
          nextCursor = data.nextCursor;
        }
      }
      const data = yield* ScheduledMessages.list(query).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not list scheduled messages", error)),
      );
      if (isJsonLinesRequested()) {
        for (const item of data.items) yield* printJsonLine(item);
        return;
      }
      if (json) return yield* printJson(data);
      if (data.items.length === 0) {
        return yield* Console.log(
          "No scheduled messages. Create one with `samva scheduled-messages create`.",
        );
      }
      for (const item of data.items) {
        yield* printFields([
          ["ID", item.id],
          ["Status", item.status],
          ["Channel", item.send.channel],
          ["Send at", item.scheduledFor],
          ["Timezone", item.timezone],
        ]);
        yield* Console.log("");
      }
      if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const get = Command.make("get", { id: Argument.String("id"), json: jsonFlag }).pipe(
  Command.withDescription("Show a scheduled message by id"),
  Command.withExamples([{ command: "samva scheduled-messages get sched_abc123" }]),
  Command.withHandler(({ id, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* ScheduledMessages.get({ id }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not fetch scheduled message", error)),
      );
      if (json) return yield* printJson(data);
      yield* printFields([
        ["ID", data.id],
        ["Status", data.status],
        ["Channel", data.send.channel],
        ["Send at", data.scheduledFor],
        ["Timezone", data.timezone],
        ["Message ID", data.messageId],
        ["Reference", data.referenceId],
        ["Failure", data.failureReason],
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const cancel = Command.make("cancel", {
  id: Argument.String("id"),
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Cancel a pending scheduled message"),
  Command.withExamples([
    { command: "samva scheduled-messages cancel sched_abc123 --dry-run" },
    { command: "samva scheduled-messages cancel sched_abc123 --yes" },
  ]),
  Command.withHandler(({ id, dryRun, yes, json }) =>
    Effect.gen(function* () {
      if (dryRun) {
        return yield* json
          ? printJson({ dryRun: true, action: "scheduled.cancel", id })
          : Console.log(`[dry-run] Would cancel scheduled message ${id}.`);
      }
      yield* confirmDestructive({
        yes,
        json,
        message: `Cancel scheduled message ${id}?`,
        nonInteractiveMessage:
          "Scheduled message cancellation requires --yes in non-interactive mode. Preview with --dry-run.",
      });
      const client = yield* getClientProvider;
      const data = yield* ScheduledMessages.cancel({ id }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not cancel scheduled message", error)),
      );
      if (json) return yield* printJson(data);
      yield* Effect.logInfo("Scheduled message cancelled.\n");
      yield* printFields([
        ["ID", data.item.id],
        ["Status", data.item.status],
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const resume = Command.make("resume", {
  id: Argument.String("id"),
  sendNow: Flag.Boolean("send-now").pipe(
    Flag.withDescription("Send immediately after review clearance"),
    Flag.withDefault(false),
  ),
  at: Flag.String("at").pipe(
    Flag.withDescription("New absolute future send instant"),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Resume a scheduled message paused by email review"),
  Command.withExamples([
    { command: "samva scheduled-messages resume sched_abc123 --send-now" },
    {
      command: "samva scheduled-messages resume sched_abc123 --at 2026-10-01T09:00:00Z --json",
    },
  ]),
  Command.withHandler(({ id, sendNow, at, json }) =>
    Effect.gen(function* () {
      const atValue = Option.getOrUndefined(at);
      if (sendNow === Boolean(atValue)) {
        return yield* new SamvaCliError({
          message: "Choose exactly one of --send-now or --at.",
        });
      }
      if (atValue !== undefined && !isAbsoluteInstant(atValue)) {
        return yield* new SamvaCliError({
          message:
            "--at must be an absolute ISO 8601 instant with Z or an offset, e.g. 2026-10-01T09:00:00Z.",
        });
      }
      const client = yield* getClientProvider;
      const data = yield* ScheduledMessages.resume(
        sendNow
          ? { id, choice: "send_now" }
          : { id, choice: "new_time", scheduledFor: new Date(atValue!) },
      ).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not resume scheduled message", error)),
      );
      if (json) return yield* printJson(data);
      yield* printFields([
        ["ID", data.id],
        ["Status", data.status],
        ["Send at", data.scheduledFor],
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

export const scheduledMessagesCommand = Command.make("scheduled-messages").pipe(
  Command.withDescription("Schedule messages to send at a future time"),
  Command.withExamples([
    {
      command:
        'samva scheduled-messages create --to you@example.com --subject Hi --html "<p>Hello</p>" --at 2026-08-01T09:00:00Z',
      description: "Schedule an email",
    },
    { command: "samva scheduled-messages list", description: "List scheduled messages" },
  ]),
  Command.withSubcommands([create, list, get, cancel, resume]),
);
