import { MailboxActionState } from "@samva/core/mailboxes/action-event-policy";
import { UpdateMailboxPayload } from "@samva/core/mailboxes/resource";
import { MailboxThreadFolder, UpdateMailboxThreadPayload } from "@samva/core/mailboxes/thread";
import { ReviewRound } from "@samva/core/policy";
import {
  MailboxActionId,
  MailboxEndpointId,
  MailboxId,
  MailboxLabelId,
  MailboxThreadId,
  MessageId,
  NamespaceId,
  TemplateId,
} from "@samva/core/shared/base";
import { Cursor } from "@samva/core/shared/cursor";
import { CHANNEL_VALUES, channelSchema, type Channel } from "@samva/core/shared/enums";
import { Console, Effect, FileSystem, Option, Predicate, Schema } from "effect";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import type * as HttpClient from "effect/http/HttpClient";
import * as Mailboxes from "samva/effect/mailboxes";

import { CliUsageError, SamvaCliError } from "../errors";
import { getClientProvider } from "../lib/client";
import { connectOperation, deriveOverride } from "../lib/derive/curated";
import { mailboxApiError } from "../lib/mailbox-errors";
import {
  printAction,
  printHeldMessage,
  printMailbox,
  printMailboxSummary,
  printMessage,
  printReceipt,
  printThread,
} from "../lib/mailbox-output";
import {
  decodeMailbox,
  decodeMessage,
  decodeReceipt,
  decodeThreadPage,
  decodeOrganizationThreadPage,
  decodeNeedsYou,
  getMailboxJson,
  postMailboxJson,
} from "../lib/mailbox-wire";
import { jsonFlag, printFields, printJson } from "../lib/output";
import { mailboxesEventsCommand } from "./mailboxes-events";
import { mailboxesImportCommand, mailboxesImportStatusCommand } from "./mailboxes-import";

const mailboxIdArgument = Argument.String("mailbox-id").pipe(Argument.withSchema(MailboxId));
const messageIdArgument = Argument.String("message-id").pipe(Argument.withSchema(MessageId));
/** A mailbox write that may answer through the SDK or the raw wire, kept apart for rendering. */
type MailboxTransportResult =
  | { readonly mode: "sdk"; readonly data: Effect.Success<ReturnType<typeof Mailboxes.create>> }
  | { readonly mode: "raw"; readonly data: unknown };
const optional = (name: string) => Flag.String(name).pipe(Flag.optional);
const pageFlags = {
  limit: Flag.Int("limit").pipe(Flag.withDescription("Items per page"), Flag.optional),
  cursor: Flag.String("cursor").pipe(
    Flag.withDescription("Resume after this nextCursor from a previous page"),
    Flag.optional,
  ),
  all: Flag.Boolean("all").pipe(
    Flag.withDescription("Traverse every page (requires --jsonl)"),
    Flag.withDefault(false),
  ),
};
const instantFlag = (name: string, description: string) =>
  Flag.String(name).pipe(
    Flag.withDescription(description),
    Flag.withSchema(Schema.DateFromString),
    Flag.optional,
    Flag.map(Option.map((instant) => instant.toISOString())),
  );
const bodyFlags = {
  text: optional("text"),
  html: optional("html"),
  idempotencyKey: optional("idempotency-key"),
};
const body = (text: Option.Option<string>, html: Option.Option<string>) => {
  if (Option.isSome(text) === Option.isSome(html))
    return Effect.fail(
      new CliUsageError({
        code: "mailbox_body_required",
        message: "Provide exactly one of --text or --html.",
      }),
    );
  return Effect.succeed({
    ...(Option.isSome(text) ? { text: text.value } : {}),
    ...(Option.isSome(html) ? { html: html.value } : {}),
  });
};
const channelFlag = Flag.Literals("channel", CHANNEL_VALUES).pipe(
  Flag.withDescription("The channel: email, or a connected whatsapp or sms number"),
  Flag.withDefault("email"),
);
const chatOnlyFlags = {
  template: Flag.String("template").pipe(
    Flag.withDescription("WhatsApp only: send this approved template (tmpl_…) instead of --text"),
    Flag.optional,
  ),
  data: Flag.String("data").pipe(
    Flag.withDescription("WhatsApp only: the template's variables as a JSON object"),
    Flag.optional,
  ),
};
const usage = (code: string, message: string) => new CliUsageError({ code, message });
/**
 * The content of a WhatsApp or SMS send or reply: `--text`, or on WhatsApp an approved
 * `--template` with its `--data`. Free-form WhatsApp text needs the customer's open 24-hour
 * service window; the API refuses it otherwise, and never converts it.
 */
const chatContent = (
  channel: "whatsapp" | "sms",
  flags: {
    readonly text: Option.Option<string>;
    readonly html: Option.Option<string>;
    readonly template: Option.Option<string>;
    readonly data: Option.Option<string>;
  },
) =>
  Effect.gen(function* () {
    if (Option.isSome(flags.html))
      return yield* usage(
        "mailbox_chat_html",
        `--html is for email; a ${channel} message is text.`,
      );
    if (Option.isSome(flags.text) === Option.isSome(flags.template))
      return yield* usage(
        "mailbox_chat_content_required",
        channel === "whatsapp"
          ? "Provide exactly one of --text or --template."
          : "Provide --text; a template sends on WhatsApp only.",
      );
    if (Option.isNone(flags.template)) {
      if (Option.isSome(flags.data))
        return yield* usage("mailbox_chat_data", "--data needs --template.");
      return Option.isSome(flags.text) ? { text: flags.text.value } : {};
    }
    if (channel !== "whatsapp")
      return yield* usage("mailbox_chat_template", "A template sends on WhatsApp only.");
    const templateId = yield* Schema.decodeEffect(TemplateId)(flags.template.value).pipe(
      Effect.mapError(() =>
        usage("mailbox_chat_template", "--template must be an approved template id (tmpl_…)."),
      ),
    );
    const dataText = Option.getOrUndefined(flags.data);
    if (dataText === undefined) return { templateId };
    const raw = yield* Effect.try({
      try: (): unknown => JSON.parse(dataText),
      catch: () => usage("mailbox_chat_data", "--data must be valid JSON."),
    });
    if (!Predicate.isObject(raw) || Array.isArray(raw))
      return yield* usage("mailbox_chat_data", "--data must be a JSON object.");
    return { templateId, templateData: raw };
  });
/** A chat send's idempotency header, when the caller chose a key. */
const keyHeader = (key: Option.Option<string>) =>
  Option.isSome(key) ? { "idempotency-key": key.value } : undefined;
/** A `--cursor` this command printed, passed on unchanged; anything else is a usage error. */
const checkCursor = (
  cursor: string | undefined,
): Effect.Effect<string | undefined, CliUsageError> =>
  cursor === undefined
    ? Effect.void.pipe(Effect.as(undefined))
    : Schema.decodeEffect(Cursor)(cursor).pipe(
        Effect.as(cursor),
        Effect.mapError(
          () =>
            new CliUsageError({
              code: "mailbox_cursor_invalid",
              message: "The cursor is not a nextCursor this command printed.",
            }),
        ),
      );

/** A query string from the defined values, or nothing when there are none. */
const searchParams = (
  values: Readonly<Record<string, string | number | boolean | readonly string[] | undefined>>,
) => {
  const query = new URLSearchParams(
    Object.entries(values).flatMap(([name, value]) =>
      value === undefined
        ? []
        : Array.isArray(value)
          ? value.map((item) => [name, item])
          : [[name, String(value)]],
    ),
  ).toString();
  return query === "" ? "" : `?${query}`;
};

const list = deriveOverride(
  "list",
  {
    namespace: Flag.String("namespace").pipe(Flag.withSchema(NamespaceId), Flag.optional),
    ...pageFlags,
    after: instantFlag("after", "Only mailboxes created after this ISO 8601 instant"),
    before: instantFlag("before", "Only mailboxes created before this ISO 8601 instant"),
    json: jsonFlag,
  },
  {
    mapInput: ({ namespace, limit, cursor, after, before }) => ({
      namespaceId: Option.getOrUndefined(namespace),
      cursor: Option.getOrUndefined(cursor),
      limit: Option.getOrUndefined(limit),
      after: Option.getOrUndefined(after),
      before: Option.getOrUndefined(before),
    }),
    call: (request) => Mailboxes.list(request),
    failure: (error) => mailboxApiError("Could not list mailboxes", error),
    paginate: {
      withCursor: (request, cursor) => ({ ...request, cursor }),
      start: (request) => request.cursor,
      stopOnEmpty: true,
    },
    render: (data) =>
      Effect.gen(function* () {
        if (data.items.length === 0) yield* Console.log("No mailboxes found.");
        for (const item of data.items) yield* printMailboxSummary(item);
        if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
      }),
  },
).pipe(
  Command.withDescription("List mailboxes the caller can read"),
  Command.withExamples([
    { command: "samva mailboxes list --json" },
    { command: "samva mailboxes list --all --jsonl", description: "Stream every page as JSONL" },
  ]),
);
const createFlags = {
  channel: channelFlag,
  address: Flag.String("address").pipe(
    Flag.withDescription(
      "The mailbox's address: an email address such as support@acme.samva.email, or on whatsapp and sms a number you connected, in E.164 form such as +14155550123",
    ),
  ),
  name: Flag.String("name"),
  idempotencyKey: optional("idempotency-key"),
  slug: Flag.String("slug").pipe(
    Flag.withDescription("Defaults to the address's local part, or a phone number's digits"),
    Flag.optional,
  ),
  namespace: Flag.String("namespace").pipe(Flag.withSchema(NamespaceId), Flag.optional),
  json: jsonFlag,
};
const createRequest = ({
  channel,
  address,
  name,
  slug,
  namespace,
  idempotencyKey,
}: Command.Command.Config.Infer<typeof createFlags>) => ({
  channel,
  payload: {
    endpoint: { channel, address },
    name,
    ...(Option.isSome(slug) ? { slug: slug.value } : {}),
    ...(Option.isSome(namespace) ? { namespaceId: namespace.value } : {}),
  },
  idempotencyKey: Option.getOrUndefined(idempotencyKey),
  headers: keyHeader(idempotencyKey),
});
const create = deriveOverride<
  "create",
  typeof createFlags,
  ReturnType<typeof createRequest>,
  MailboxTransportResult,
  Effect.Error<typeof getClientProvider> | SamvaCliError,
  never,
  never,
  never,
  SamvaCliError
>("create", createFlags, {
  mapInput: createRequest,
  connect: connectOperation<
    ReturnType<typeof createRequest>,
    MailboxTransportResult,
    Effect.Error<typeof getClientProvider> | SamvaCliError,
    Effect.Services<typeof getClientProvider> | HttpClient.HttpClient
  >((request) =>
    Effect.gen(function* () {
      if (request.channel === "email") {
        const client = yield* getClientProvider;
        const data = yield* Mailboxes.create(
          {
            endpoint: { channel: "email", address: request.payload.endpoint.address },
            name: request.payload.name,
            ...(request.payload.slug === undefined ? {} : { slug: request.payload.slug }),
            ...(request.payload.namespaceId === undefined
              ? {}
              : { namespaceId: request.payload.namespaceId }),
          },
          { idempotencyKey: request.idempotencyKey },
        ).pipe(
          client.provide,
          Effect.mapError((e) => mailboxApiError("Could not create mailbox", e)),
        );
        return { mode: "sdk" as const, data };
      }
      const raw = yield* postMailboxJson(
        "Could not create mailbox",
        "/v1/mailboxes",
        request.payload,
        request.headers,
      );
      return { mode: "raw" as const, data: raw };
    }),
  ),
  mapOutput: (result: MailboxTransportResult) => result.data,
  render: (result: MailboxTransportResult) =>
    result.mode === "raw"
      ? decodeMailbox(result.data).pipe(Effect.flatMap(printMailbox))
      : printMailbox(result.data),
}).pipe(
  Command.withDescription("Create a mailbox with one endpoint on a channel (email by default)"),
  Command.withExamples([
    {
      command: "samva mailboxes create --address support@acme.samva.email --name Support",
    },
    {
      command: "samva mailboxes create --channel whatsapp --address +14155550123 --name Concierge",
      description: "A mailbox on a connected WhatsApp number",
    },
  ]),
);
const get = deriveOverride(
  "get",
  { id: mailboxIdArgument, json: jsonFlag },
  {
    mapInput: ({ id }) => ({ id }),
    connect: connectOperation((request: { id: MailboxId }) =>
      getMailboxJson("Could not read mailbox", `/v1/mailboxes/${request.id}`).pipe(
        Effect.flatMap((raw) =>
          decodeMailbox(raw).pipe(Effect.map((decoded) => ({ raw, decoded }))),
        ),
      ),
    ),
    mapOutput: ({ raw }) => raw,
    render: ({ decoded }) => printMailbox(decoded),
  },
).pipe(Command.withDescription("Inspect a mailbox's endpoints and settings"));
const update = Command.make("update", {
  id: mailboxIdArgument,
  data: Flag.String("data").pipe(
    Flag.withDescription("JSON patch or @file: name, metadata (null deletes a metadata key)"),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Update mailbox settings from JSON"),
  Command.withExamples([
    {
      command: `samva mailboxes update mbx_1234567890123456 --data '{"name":"Support","metadata":{"tier":"gold"}}'`,
    },
  ]),
  Command.withHandler(({ id, data, dryRun, json }) =>
    Effect.gen(function* () {
      let source = data;
      if (data.startsWith("@")) {
        const path = data.slice(1);
        if (!path)
          return yield* new CliUsageError({
            code: "missing_data_file",
            message: "--data @ requires a file path.",
          });
        const fs = yield* FileSystem.FileSystem;
        source = yield* fs.readFileString(path).pipe(
          Effect.mapError(
            () =>
              new CliUsageError({
                code: "data_file_unreadable",
                message: `Could not read mailbox update data from ${path}.`,
              }),
          ),
        );
      }
      const raw = yield* Effect.try({
        try: (): unknown => JSON.parse(source),
        catch: () =>
          new CliUsageError({
            code: "mailbox_update_invalid",
            message: "--data must be valid JSON.",
          }),
      });
      const payload = yield* Schema.decodeUnknownEffect(UpdateMailboxPayload)(raw, {
        onExcessProperty: "error",
        errors: "all",
      }).pipe(
        Effect.mapError(
          (e) =>
            new CliUsageError({
              code: "mailbox_update_invalid",
              message: `--data must match the mailbox update schema: ${String(e)}`,
            }),
        ),
      );
      if (!Object.keys(payload).length)
        return yield* new CliUsageError({
          code: "mailbox_update_empty",
          message: "--data must name at least one of name or metadata.",
        });
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "mailboxes.update", id, request: payload })
          : printFields([
              ["Dry run", true],
              ["Mailbox", id],
              ["Patch", JSON.stringify(payload)],
            ]);
      const client = yield* getClientProvider;
      const result = yield* Mailboxes.update({ id, ...payload }).pipe(
        client.provide,
        Effect.mapError((e) => mailboxApiError("Could not update mailbox", e)),
      );
      yield* json ? printJson(result) : printMailbox(result);
    }),
  ),
);
const threadUpdate = Command.make("thread-update", {
  id: mailboxIdArgument,
  threadId: Argument.String("thread-id").pipe(Argument.withSchema(MailboxThreadId)),
  data: Flag.String("data").pipe(
    Flag.withDescription(
      "JSON patch or @file: done, closed, folder, priority, read, starred, snoozedUntil, ifNoReply",
    ),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Update shared thread state or your own Done state"),
  Command.withExamples([
    {
      command: `samva mailboxes thread-update mbx_1234567890123456 thread_1234567890123456 --data '{"done":true}'`,
    },
  ]),
  Command.withHandler(({ id, threadId, data, dryRun, json }) =>
    Effect.gen(function* () {
      let source = data;
      if (data.startsWith("@")) {
        const path = data.slice(1);
        if (!path)
          return yield* new CliUsageError({
            code: "missing_data_file",
            message: "--data @ requires a file path.",
          });
        const fs = yield* FileSystem.FileSystem;
        source = yield* fs.readFileString(path).pipe(
          Effect.mapError(
            () =>
              new CliUsageError({
                code: "data_file_unreadable",
                message: `Could not read mailbox update data from ${path}.`,
              }),
          ),
        );
      }
      const raw = yield* Effect.try({
        try: (): unknown => JSON.parse(source),
        catch: () =>
          new CliUsageError({
            code: "mailbox_thread_update_invalid",
            message: "--data must be valid JSON.",
          }),
      });
      const payload = yield* Schema.decodeUnknownEffect(
        Schema.toEncoded(UpdateMailboxThreadPayload),
      )(raw, {
        onExcessProperty: "error",
        errors: "all",
      }).pipe(
        Effect.mapError(
          (e) =>
            new CliUsageError({
              code: "mailbox_thread_update_invalid",
              message: `--data must match the mailbox update schema: ${String(e)}`,
            }),
        ),
      );
      if (!Object.keys(payload).length)
        return yield* new CliUsageError({
          code: "mailbox_thread_update_empty",
          message: "--data must name at least one thread field.",
        });
      if (dryRun)
        return yield* json
          ? printJson({
              dryRun: true,
              action: "mailboxes.thread-update",
              id,
              threadId,
              request: payload,
            })
          : printFields([
              ["Dry run", true],
              ["Mailbox", id],
              ["Patch", JSON.stringify(payload)],
            ]);
      const client = yield* getClientProvider;
      const result = yield* Mailboxes.updateThread({ id, threadId, ...payload }).pipe(
        client.provide,
        Effect.mapError((e) => mailboxApiError("Could not update thread", e)),
      );
      yield* json
        ? printJson(result)
        : printFields(
            Object.entries(result).map(([key, value]) => [
              key,
              Predicate.isObject(value) ? JSON.stringify(value) : value,
            ]),
          );
    }),
  ),
);
const endpointAddFlags = {
  mailbox: mailboxIdArgument,
  channel: channelFlag,
  address: Flag.String("address").pipe(
    Flag.withDescription(
      "The address to add: an email address such as billing@acme.samva.email, or on whatsapp and sms a number you connected, in E.164 form such as +14155550123",
    ),
  ),
  displayName: Flag.String("display-name").pipe(
    Flag.withDescription("The sender name messages from this endpoint carry"),
    Flag.optional,
  ),
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  json: jsonFlag,
};
const endpointAddRequest = ({
  mailbox,
  channel,
  address,
  displayName,
}: Command.Command.Config.Infer<typeof endpointAddFlags>) => ({
  id: mailbox,
  channel,
  payload: {
    channel,
    address,
    displayName: Option.getOrUndefined(displayName),
  },
});
const endpointAdd = deriveOverride<
  "add",
  typeof endpointAddFlags,
  ReturnType<typeof endpointAddRequest>,
  MailboxTransportResult,
  Effect.Error<typeof getClientProvider> | SamvaCliError,
  never,
  never,
  never,
  SamvaCliError
>("add", endpointAddFlags, {
  mapInput: endpointAddRequest,
  connect: connectOperation<
    ReturnType<typeof endpointAddRequest>,
    MailboxTransportResult,
    Effect.Error<typeof getClientProvider> | SamvaCliError,
    Effect.Services<typeof getClientProvider> | HttpClient.HttpClient
  >((request) =>
    Effect.gen(function* () {
      if (request.channel === "email") {
        const client = yield* getClientProvider;
        const data = yield* Mailboxes.createEndpoint({
          id: request.id,
          channel: "email",
          address: request.payload.address,
          ...(request.payload.displayName === undefined
            ? {}
            : { displayName: request.payload.displayName }),
        }).pipe(
          client.provide,
          Effect.mapError((e) => mailboxApiError("Could not add the endpoint", e)),
        );
        return { mode: "sdk" as const, data };
      }
      const raw = yield* postMailboxJson(
        "Could not add the endpoint",
        `/v1/mailboxes/${request.id}/endpoints`,
        request.payload,
      );
      return { mode: "raw" as const, data: raw };
    }),
  ),
  preview: {
    data: (request) => ({
      dryRun: true,
      action: "mailboxes.createEndpoint",
      id: request.id,
      request: request.payload,
    }),
    render: (request) =>
      Console.log(`[dry-run] Would add ${request.payload.address} to mailbox ${request.id}.`),
  },
  mapOutput: (result: MailboxTransportResult) => result.data,
  render: (result: MailboxTransportResult) =>
    result.mode === "raw"
      ? decodeMailbox(result.data).pipe(Effect.flatMap(printMailbox))
      : printMailbox(result.data),
}).pipe(
  Command.withDescription("Add an endpoint on a channel (email by default) to a mailbox"),
  Command.withExamples([
    {
      command:
        "samva mailboxes endpoints add mbx_1234567890123456 --address billing@acme.samva.email",
    },
    {
      command:
        "samva mailboxes endpoints add mbx_1234567890123456 --channel whatsapp --address +14155550123",
      description: "Add a connected WhatsApp number",
    },
  ]),
);
const endpointIdArgument = Argument.String("endpoint-id").pipe(
  Argument.withSchema(MailboxEndpointId),
);
const endpointUpdate = deriveOverride(
  "update",
  {
    mailbox: mailboxIdArgument,
    endpointId: endpointIdArgument,
    displayName: Flag.String("display-name").pipe(
      Flag.withDescription("The sender name messages from this endpoint carry"),
      Flag.optional,
    ),
    clearDisplayName: Flag.Boolean("clear-display-name").pipe(
      Flag.withDescription("Send under the mailbox's name again"),
      Flag.withDefault(false),
    ),
    makeDefault: Flag.Boolean("default").pipe(
      Flag.withDescription("Start new conversations from this endpoint on its channel"),
      Flag.withDefault(false),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    json: jsonFlag,
  },
  {
    prepare: ({ mailbox, endpointId, displayName, clearDisplayName, makeDefault }) =>
      Effect.gen(function* () {
        if (Option.isSome(displayName) && clearDisplayName)
          return yield* new CliUsageError({
            code: "endpoint_update_invalid",
            message: "Use either --display-name or --clear-display-name, not both.",
          });
        if (Option.isNone(displayName) && !clearDisplayName && !makeDefault)
          return yield* new CliUsageError({
            code: "endpoint_update_empty",
            message: "Name at least one of --display-name, --clear-display-name, or --default.",
          });
        return {
          id: mailbox,
          endpointId,
          ...(Option.isSome(displayName)
            ? { displayName: displayName.value }
            : clearDisplayName
              ? { displayName: null }
              : {}),
          ...(makeDefault ? { default: true as const } : {}),
        };
      }),
    call: (request) => Mailboxes.updateEndpoint(request),
    failure: "Could not update the endpoint",
    preview: {
      data: (request) => {
        const { id, endpointId, ...payload } = request;
        return {
          dryRun: true,
          action: "mailboxes.updateEndpoint",
          id,
          endpointId,
          request: payload,
        };
      },
      render: (request) =>
        Console.log(
          `[dry-run] Would update endpoint ${request.endpointId} of mailbox ${request.id}.`,
        ),
    },
    render: (data) => printMailbox(data),
  },
).pipe(
  Command.withDescription("Rename an endpoint's sender or make it the mailbox's default"),
  Command.withExamples([
    {
      command:
        'samva mailboxes endpoints update mbx_1234567890123456 mbxep_1234567890123456 --display-name "Acme Billing" --default',
    },
  ]),
);
const endpointRemove = deriveOverride(
  "remove",
  {
    mailbox: mailboxIdArgument,
    endpointId: endpointIdArgument,
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
    json: jsonFlag,
  },
  {
    mapInput: ({ mailbox, endpointId }) => ({ id: mailbox, endpointId }),
    call: (request) => Mailboxes.removeEndpoint(request),
    failure: "Could not remove the endpoint",
    preview: {
      data: (request) => ({
        dryRun: true,
        action: "mailboxes.removeEndpoint",
        id: request.id,
        endpointId: request.endpointId,
      }),
      render: (request) =>
        Console.log(
          `[dry-run] Would remove endpoint ${request.endpointId} from mailbox ${request.id}.`,
        ),
    },
    confirmation: (request) => ({
      message: `Remove endpoint ${request.endpointId} from mailbox ${request.id}? Mail sent to it will stop reaching the mailbox.`,
      nonInteractiveMessage:
        "Removing an endpoint requires --yes in non-interactive mode. Preview with --dry-run.",
    }),
    render: (data) => printMailbox(data),
  },
).pipe(
  Command.withDescription(
    "Remove an endpoint from a mailbox; mail sent to it stops reaching the mailbox",
  ),
  Command.withExamples([
    {
      command: "samva mailboxes endpoints remove mbx_1234567890123456 mbxep_1234567890123456 --yes",
    },
  ]),
);
const lifecycle = (verb: "pause" | "resume") =>
  deriveOverride(
    verb,
    {
      id: mailboxIdArgument,
      dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
      json: jsonFlag,
    },
    {
      mapInput: ({ id }) => ({ id }),
      call: (request) => Mailboxes[verb](request),
      failure: `Could not ${verb} mailbox`,
      preview: {
        data: (request) => ({ dryRun: true, action: `mailboxes.${verb}`, id: request.id }),
        render: (request) => Console.log(`[dry-run] Would ${verb} mailbox ${request.id}.`),
      },
      render: (data) => printMailbox(data),
    },
  ).pipe(
    Command.withDescription(
      verb === "pause"
        ? "Pause sending and inbound delivery; mail arriving while paused is not backfilled"
        : "Resume mailbox delivery",
    ),
  );
const actionsList = deriveOverride(
  "list",
  {
    mailbox: mailboxIdArgument,
    ...pageFlags,
    state: Flag.Literals("state", MailboxActionState.literals).pipe(Flag.optional),
    after: instantFlag("after", "Only actions created after this ISO 8601 instant"),
    before: instantFlag("before", "Only actions created before this ISO 8601 instant"),
    json: jsonFlag,
  },
  {
    mapInput: ({ mailbox, limit, cursor, state, after, before }) => ({
      id: mailbox,
      limit: Option.getOrUndefined(limit),
      cursor: Option.getOrUndefined(cursor),
      state: Option.getOrUndefined(state),
      after: Option.getOrUndefined(after),
      before: Option.getOrUndefined(before),
    }),
    call: (request) => Mailboxes.listActions(request),
    failure: "Could not list actions",
    paginate: {
      withCursor: (request, cursor) => ({ ...request, cursor }),
      start: (request) => request.cursor,
      stopOnEmpty: true,
    },
    render: (data) =>
      Effect.gen(function* () {
        if (data.items.length === 0) yield* Console.log("No mailbox actions found.");
        for (const item of data.items) yield* printAction(item);
        if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
      }),
  },
).pipe(Command.withDescription("List mailbox actions and their policy decisions"));
const actionDecision = (verb: "approve" | "deny") => {
  const common = {
    mailbox: mailboxIdArgument,
    actionId: Argument.String("action-id").pipe(Argument.withSchema(MailboxActionId)),
    reviewRound: Flag.Int("review-round").pipe(
      Flag.withSchema(ReviewRound),
      Flag.withDescription(
        "The reviewRound on the held action's decision; required for that exact hold",
      ),
    ),
  };
  const tail = {
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
    json: jsonFlag,
  };
  if (verb === "deny")
    return deriveOverride(
      "deny",
      {
        ...common,
        reason: optional("reason").pipe(
          Flag.withDescription("Denial reason; defaults to Denied by reviewer."),
        ),
        ...tail,
      },
      {
        prepare: ({ mailbox, actionId, reviewRound, reason }) =>
          Effect.succeed({
            id: mailbox,
            actionId,
            reviewRound,
            reason: Option.getOrElse(reason, () => "Denied by reviewer."),
          }),
        call: (request) => Mailboxes.denyAction(request),
        failure: (error) => mailboxApiError("Could not deny action", error, { personOnly: "deny" }),
        preview: {
          data: (request) => ({
            dryRun: true,
            action: "mailboxes.actions.deny",
            id: request.id,
            actionId: request.actionId,
            reviewRound: request.reviewRound,
            reason: request.reason,
          }),
          render: (request) =>
            Console.log(
              `[dry-run] Would deny review round ${request.reviewRound} of mailbox action ${request.actionId} in mailbox ${request.id} with reason: ${request.reason}.`,
            ),
        },
        confirmation: (request) => ({
          message: `Deny review round ${request.reviewRound} of mailbox action ${request.actionId}?`,
          nonInteractiveMessage:
            "Action deny requires --yes in non-interactive mode. Preview with --dry-run.",
        }),
        render: (data) => printAction(data),
      },
    ).pipe(
      Command.withDescription(
        "Deny the observed review round as a signed-in person other than its proposer",
      ),
      Command.withExamples([
        {
          command: `samva mailboxes actions deny mbx_1234567890123456 mbxact_1234567890123456 --review-round 2 --reason "Wrong recipient" --yes`,
          description: "Use the reviewRound from the decision you reviewed",
        },
      ]),
    );
  return deriveOverride(
    "approve",
    {
      ...common,
      always: Flag.Boolean("always").pipe(
        Flag.withDefault(false),
        Flag.withDescription(
          "Allow matching future actions from this actor, subject to policy floors and guards. For an agent's integration tool call this lets the tool run without approval for every agent, which only the organization owner may do; the action's alwaysAllow says who may",
        ),
      ),
      editText: optional("edit-text").pipe(
        Flag.withDescription("Replace the held message text before approving"),
      ),
      ...tail,
    },
    {
      prepare: ({ mailbox, actionId, reviewRound, always, editText }) =>
        Effect.succeed({
          id: mailbox,
          actionId,
          reviewRound,
          ...(always ? { always: true as const } : {}),
          ...(Option.isSome(editText) ? { edits: { text: editText.value } } : {}),
        }),
      call: (request) => Mailboxes.approveAction(request),
      failure: (error) =>
        mailboxApiError("Could not approve action", error, { personOnly: "approve" }),
      preview: {
        data: (request) => ({
          dryRun: true,
          action: "mailboxes.actions.approve",
          id: request.id,
          actionId: request.actionId,
          reviewRound: request.reviewRound,
          always: request.always ?? false,
          ...(request.edits === undefined ? {} : { edits: request.edits }),
        }),
        render: (request) =>
          Console.log(
            `[dry-run] Would approve review round ${request.reviewRound} of mailbox action ${request.actionId} in mailbox ${request.id}${
              request.edits === undefined
                ? ""
                : ` with replacement text: ${JSON.stringify(request.edits.text)}`
            }${request.always ? "; allow matching future actions from this actor" : ""}.`,
          ),
      },
      confirmation: (request) => ({
        message: `Approve and execute review round ${request.reviewRound} of mailbox action ${request.actionId}${request.always ? " and allow matching future actions from this actor" : ""}?`,
        nonInteractiveMessage:
          "Action approve requires --yes in non-interactive mode. Preview with --dry-run.",
      }),
      render: (data) => printAction(data),
    },
  ).pipe(
    Command.withDescription(
      "Approve and execute the observed review round as a signed-in person other than its proposer",
    ),
    Command.withExamples([
      {
        command: `samva mailboxes actions approve mbx_1234567890123456 mbxact_1234567890123456 --review-round 2 --yes`,
        description: "Use the reviewRound from the decision you reviewed",
      },
      {
        command:
          'samva mailboxes actions approve mbx_1234567890123456 mbxact_1234567890123456 --review-round 2 --edit-text "Reviewed reply" --yes',
      },
    ]),
  );
};
const remove = deriveOverride(
  "remove",
  {
    id: Argument.String("mailbox-id").pipe(Argument.withSchema(MailboxId)),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
    json: jsonFlag,
  },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => Mailboxes.remove(request),
    failure: "Could not remove mailbox",
    preview: {
      data: (request) => ({ dryRun: true, action: "mailboxes.remove", id: request.id }),
      render: (request) => Console.log(`[dry-run] Would permanently remove mailbox ${request.id}.`),
    },
    confirmation: (request) => ({
      message: `Permanently remove mailbox ${request.id} with its threads, drafts, and history?`,
      nonInteractiveMessage:
        "Permanent mailbox deletion requires --yes in non-interactive mode. Preview with --dry-run.",
    }),
    render: (_data, _input, request) =>
      Console.log(
        `Removed mailbox ${request.id}. The messages it received stay with the organization.`,
      ),
  },
).pipe(
  Command.withDescription(
    "Permanently delete a mailbox with its endpoints, threads, drafts, and history",
  ),
  Command.withExamples([
    { command: "samva mailboxes remove mbx_1234567890123456 --dry-run" },
    { command: "samva mailboxes remove mbx_1234567890123456 --yes" },
  ]),
);
const trashFlags = {
  mailbox: mailboxIdArgument,
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
  json: jsonFlag,
};

const deleteThread = deriveOverride(
  "delete",
  {
    ...trashFlags,
    threadId: Argument.String("thread-id").pipe(Argument.withSchema(MailboxThreadId)),
  },
  {
    mapInput: ({ mailbox, threadId }) => ({ id: mailbox, threadId }),
    call: (request) => Mailboxes.deleteThread(request),
    failure: "Could not delete thread",
    preview: {
      data: (request) => ({
        dryRun: true,
        action: "mailboxes.threads.delete",
        id: request.id,
        threadId: request.threadId,
      }),
      render: (request) =>
        Console.log(
          `[dry-run] Would permanently delete thread ${request.threadId} from mailbox ${request.id}.`,
        ),
    },
    confirmation: (request) => ({
      message: `Permanently delete thread ${request.threadId} from mailbox ${request.id}?`,
      nonInteractiveMessage:
        "Permanent thread deletion requires --yes in non-interactive mode. Preview with --dry-run.",
    }),
    mapOutput: (_data, _input, request) => ({ deleted: true, threadId: request.threadId }),
    render: (_data, _input, request) => Console.log(`Deleted thread ${request.threadId}.`),
  },
).pipe(Command.withDescription("Permanently delete a mailbox thread from Trash or Spam"));

const emptyFolder = (folder: "trash" | "spam") => {
  const label = folder === "spam" ? "Spam" : "Trash";
  return deriveOverride("empty", trashFlags, {
    mapInput: ({ mailbox }) => ({ id: mailbox }),
    call: (request) =>
      folder === "spam" ? Mailboxes.emptySpam(request) : Mailboxes.emptyTrash(request),
    failure: `Could not empty ${label}`,
    preview: {
      data: (request) => ({ dryRun: true, action: `mailboxes.${folder}.empty`, id: request.id }),
      render: (request) => Console.log(`[dry-run] Would empty ${label} for mailbox ${request.id}.`),
    },
    confirmation: (request) => ({
      message: `Permanently delete every thread in ${label} for mailbox ${request.id}?`,
      nonInteractiveMessage: `Empty ${label} requires --yes in non-interactive mode. Preview with --dry-run.`,
    }),
    render: (data) => printFields([["Threads queued for deletion", data.count]]),
  }).pipe(Command.withDescription(`Permanently delete all threads in a mailbox's ${label}`));
};

const threadsFlags = {
  mailbox: mailboxIdArgument,
  state: Flag.Literals("state", ["active", "done"]).pipe(Flag.optional),
  ...pageFlags,
  query: Flag.String("query").pipe(
    Flag.withDescription(
      "Semantic and keyword search; filters narrow results, ranked by relevance across at most 100 threads. New mail can take a few seconds to appear. Omit for recent activity.",
    ),
    Flag.optional,
  ),
  snoozed: Flag.Boolean("snoozed").pipe(Flag.optional),
  folder: Flag.Literals("folder", MailboxThreadFolder.literals).pipe(Flag.optional),
  label: Flag.String("label").pipe(Flag.withSchema(MailboxLabelId), Flag.optional),
  unread: Flag.Boolean("unread").pipe(Flag.withDefault(false)),
  starred: Flag.Boolean("starred").pipe(
    Flag.withDescription("Only threads you starred"),
    Flag.withDefault(false),
  ),
  after: instantFlag("after", "Only threads with activity after this ISO 8601 instant"),
  before: instantFlag("before", "Only threads whose last activity is before this ISO 8601 instant"),
  json: jsonFlag,
};
const threadsRequest = ({
  mailbox,
  state,
  limit,
  cursor,
  query,
  snoozed,
  folder,
  label,
  unread,
  starred,
  after,
  before,
}: Command.Command.Config.Infer<typeof threadsFlags>) => ({
  id: mailbox,
  state: Option.getOrUndefined(state),
  cursor: Option.getOrUndefined(cursor),
  limit: Option.getOrUndefined(limit),
  q: Option.getOrUndefined(query),
  snoozed: Option.getOrUndefined(snoozed),
  folder: Option.getOrUndefined(folder),
  label: Option.getOrUndefined(label),
  unread: unread ? true : undefined,
  starred: starred ? true : undefined,
  after: Option.getOrUndefined(after),
  before: Option.getOrUndefined(before),
});
const threads = deriveOverride("threads", threadsFlags, {
  mapInput: threadsRequest,
  connect: connectOperation((request: ReturnType<typeof threadsRequest>) =>
    getMailboxJson(
      "Could not list threads",
      `/v1/mailboxes/${request.id}/threads${searchParams({
        state: request.state,
        cursor: request.cursor,
        limit: request.limit,
        q: request.q,
        snoozed: request.snoozed,
        folder: request.folder,
        label: request.label,
        unread: request.unread,
        starred: request.starred,
        after: request.after,
        before: request.before,
      })}`,
    ).pipe(Effect.flatMap(decodeThreadPage)),
  ),
  paginate: {
    withCursor: (request, cursor) => ({ ...request, cursor }),
    start: (request) => request.cursor,
    stopOnEmpty: true,
  },
  render: (data) =>
    Effect.gen(function* () {
      if (data.items.length === 0) yield* Console.log("No threads found.");
      for (const item of data.items) yield* printThread(item);
      if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
    }),
}).pipe(
  Command.withDescription("Search and list mailbox threads"),
  Command.withExamples([
    { command: "samva mailboxes threads mbx_1234567890123456 --query invoice --json" },
    {
      command:
        "samva mailboxes threads mbx_1234567890123456 --starred --after 2026-10-01T00:00:00Z",
    },
    { command: "samva mailboxes threads mbx_1234567890123456 --all --jsonl" },
  ]),
);
const allThreadsFlags = {
  mailboxId: Flag.String("mailbox-id").pipe(Flag.withSchema(MailboxId), Flag.atLeast(0)),
  kind: Flag.Literals("kind", ["personal", "shared"]).pipe(Flag.optional),
  state: Flag.Literals("state", ["active", "done"]).pipe(Flag.optional),
  ...pageFlags,
  query: Flag.String("query").pipe(
    Flag.withDescription(
      "Semantic and keyword search; filters narrow results, ranked by relevance across at most 100 threads. New mail can take a few seconds to appear. Omit for recent activity.",
    ),
    Flag.optional,
  ),
  snoozed: Flag.Boolean("snoozed").pipe(Flag.optional),
  folder: Flag.Literals("folder", MailboxThreadFolder.literals).pipe(Flag.optional),
  label: Flag.String("label").pipe(Flag.withSchema(MailboxLabelId), Flag.optional),
  unread: Flag.Boolean("unread").pipe(Flag.withDefault(false)),
  starred: Flag.Boolean("starred").pipe(
    Flag.withDescription("Only threads you starred"),
    Flag.withDefault(false),
  ),
  after: instantFlag("after", "Only threads with activity after this ISO 8601 instant"),
  before: instantFlag("before", "Only threads whose last activity is before this ISO 8601 instant"),
  json: jsonFlag,
};
const allThreadsRequest = ({
  mailboxId,
  kind,
  state,
  limit,
  cursor,
  query,
  snoozed,
  folder,
  label,
  unread,
  starred,
  after,
  before,
}: Command.Command.Config.Infer<typeof allThreadsFlags>) => ({
  mailboxId: mailboxId.length ? mailboxId : undefined,
  kind: Option.getOrUndefined(kind),
  state: Option.getOrUndefined(state),
  cursor: Option.getOrUndefined(cursor),
  limit: Option.getOrUndefined(limit),
  q: Option.getOrUndefined(query),
  snoozed: Option.getOrUndefined(snoozed),
  folder: Option.getOrUndefined(folder),
  label: Option.getOrUndefined(label),
  unread: unread ? true : undefined,
  starred: starred ? true : undefined,
  after: Option.getOrUndefined(after),
  before: Option.getOrUndefined(before),
});
const allThreads = deriveOverride("all-threads", allThreadsFlags, {
  mapInput: allThreadsRequest,
  connect: connectOperation((request: ReturnType<typeof allThreadsRequest>) =>
    getMailboxJson(
      "Could not list threads",
      `/v1/mailboxes/threads${searchParams({
        mailboxId: request.mailboxId,
        kind: request.kind,
        state: request.state,
        cursor: request.cursor,
        limit: request.limit,
        q: request.q,
        snoozed: request.snoozed,
        folder: request.folder,
        label: request.label,
        unread: request.unread,
        starred: request.starred,
        after: request.after,
        before: request.before,
      })}`,
    ).pipe(Effect.flatMap(decodeOrganizationThreadPage)),
  ),
  paginate: {
    withCursor: (request, cursor) => ({ ...request, cursor }),
    start: (request) => request.cursor,
    stopOnEmpty: true,
  },
  render: (data) =>
    Effect.gen(function* () {
      if (data.items.length === 0) yield* Console.log("No threads found.");
      for (const item of data.items) {
        yield* printFields([
          ["Mailbox", item.mailbox.id],
          ["Address", item.mailbox.address],
          ["Kind", item.mailbox.kind],
        ]);
        yield* printThread(item);
      }
      if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
    }),
}).pipe(
  Command.withDescription("Search and list threads across readable mailboxes"),
  Command.withExamples([
    { command: "samva mailboxes all-threads --query invoice --json" },
    {
      command: "samva mailboxes all-threads --starred --after 2026-10-01T00:00:00Z",
    },
    { command: "samva mailboxes all-threads --all --jsonl" },
  ]),
);

const needsYou = deriveOverride(
  "needs-you",
  {
    limit: pageFlags.limit,
    cursor: pageFlags.cursor,
    json: jsonFlag,
  },
  {
    prepare: ({ limit, cursor }) =>
      Effect.gen(function* () {
        const pageCursor = yield* checkCursor(Option.getOrUndefined(cursor));
        const pageLimit = Option.getOrUndefined(limit);
        return {
          ...(pageLimit === undefined ? {} : { limit: pageLimit }),
          ...(pageCursor === undefined ? {} : { cursor: pageCursor }),
        };
      }),
    connect: connectOperation((request: { limit?: number; cursor?: string }) =>
      getMailboxJson(
        "Could not list mail needing your decision",
        `/v1/mailboxes/needs-you${searchParams({ limit: request.limit, cursor: request.cursor })}`,
      ).pipe(Effect.flatMap(decodeNeedsYou)),
    ),
    paginate: {
      withCursor: (request, cursor) => ({
        ...request,
        ...(cursor === undefined ? {} : { cursor }),
      }),
      start: (request) => request.cursor,
    },
    render: (data) =>
      Effect.gen(function* () {
        yield* printFields([
          ["Held actions", data.counts.heldActions],
          ["Quarantined messages", data.counts.quarantinedMessages],
          ["Total", data.counts.total],
        ]);
        if (!data.items.length) yield* Console.log("No mail needs your decision.");
        for (const item of data.items) {
          yield* printFields([
            ["Type", item.type],
            ["ID", item.id],
            ["Mailbox", item.mailbox.id],
            ["Address", item.mailbox.address],
            ["Kind", item.mailbox.kind],
            ["Source", item.source],
          ]);
          if (item.type === "heldAction")
            yield* printFields([
              ["Action type", item.actionType],
              ["Decision", item.decision.outcome],
              ["Review round", item.decision.reviewRound],
              ["Decider", item.decision.decider],
              ["Reason", item.decision.reason],
              ["Scopes", JSON.stringify(item.decision.scopes)],
              ["Tool", item.tool?.name],
              [
                "Tool arguments",
                item.tool === null ? undefined : JSON.stringify(item.tool.arguments),
              ],
              ["Thread", item.threadId],
              ["Draft", item.draftId],
              ["Proposed by", JSON.stringify(item.proposedBy)],
              ["Created", item.createdAt],
            ]);
          else
            yield* printFields([
              ["Reason", item.reason],
              ["Held at", item.heldAt],
            ]);
        }
        if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
      }),
  },
).pipe(
  Command.withDescription("List held actions you may approve and quarantined mail you may release"),
  Command.withExamples([{ command: "samva mailboxes needs-you --limit 20 --json" }]),
);
const read = deriveOverride(
  "read",
  {
    mailbox: mailboxIdArgument,
    messageId: messageIdArgument,
    json: jsonFlag,
  },
  {
    mapInput: ({ mailbox, messageId }) => ({ mailbox, messageId }),
    connect: connectOperation((request: { mailbox: MailboxId; messageId: MessageId }) =>
      getMailboxJson(
        "Could not read message",
        `/v1/mailboxes/${request.mailbox}/messages/${request.messageId}`,
      ).pipe(
        Effect.flatMap((raw) =>
          decodeMessage(raw).pipe(Effect.map((decoded) => ({ raw, decoded }))),
        ),
      ),
    ),
    mapOutput: ({ raw }) => raw,
    render: ({ decoded }) => printMessage(decoded),
  },
).pipe(
  Command.withDescription("Read a mailbox message"),
  Command.withExamples([
    { command: "samva mailboxes read mbx_1234567890123456 msg_1234567890123456 --json" },
  ]),
);
const send = Command.make("send", {
  mailbox: mailboxIdArgument,
  channel: channelFlag,
  to: Flag.String("to").pipe(
    Flag.withDescription("Recipient email address (repeatable), or one phone number in E.164 form"),
    Flag.atLeast(1),
  ),
  subject: Flag.String("subject").pipe(Flag.withDescription("Email only"), Flag.optional),
  cc: Flag.String("cc").pipe(Flag.atLeast(0)),
  bcc: Flag.String("bcc").pipe(Flag.atLeast(0)),
  ...bodyFlags,
  ...chatOnlyFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Send a message from a mailbox: email by default, or to one phone number with --channel whatsapp or sms",
  ),
  Command.withExamples([
    {
      command:
        'samva mailboxes send mbx_1234567890123456 --to recipient@example.com --subject Hello --text "Hello"',
    },
    {
      command:
        'samva mailboxes send mbx_1234567890123456 --channel whatsapp --to +14155550123 --template tmpl_1234567890123456 --data \'{"name":"Ada"}\'',
      description: "Open a WhatsApp conversation with an approved template",
    },
    {
      command:
        'samva mailboxes send mbx_1234567890123456 --channel sms --to +14155550123 --text "Your order shipped."',
    },
  ]),
  Command.withHandler(
    ({
      mailbox,
      channel,
      to,
      subject,
      cc,
      bcc,
      text,
      html,
      template,
      data,
      idempotencyKey,
      json,
    }) =>
      Effect.gen(function* () {
        const [first, ...rest] = to;
        if (first === undefined)
          return yield* new CliUsageError({
            code: "mailbox_recipient_required",
            message: "Provide --to.",
          });
        if (channel !== "email") {
          if (rest.length > 0 || cc.length > 0 || bcc.length > 0 || Option.isSome(subject))
            return yield* usage(
              "mailbox_chat_recipient",
              `A ${channel} message goes to one --to number; --subject, --cc, and --bcc are for email.`,
            );
          const content = yield* chatContent(channel, { text, html, template, data });
          const raw = yield* postMailboxJson(
            "Could not send message",
            `/v1/mailboxes/${mailbox}/messages`,
            { channel, to: first, ...content },
            keyHeader(idempotencyKey),
          );
          if (json) return yield* printJson(raw);
          return yield* printReceipt(yield* decodeReceipt(raw));
        }
        if (Option.isSome(template) || Option.isSome(data))
          return yield* usage("mailbox_template_channel", "--template sends on WhatsApp only.");
        if (Option.isNone(subject))
          return yield* usage("mailbox_subject_required", "An email needs --subject.");
        const content = yield* body(text, html);
        const client = yield* getClientProvider;
        const result = yield* Mailboxes.sendMessage(
          {
            id: mailbox,
            to: [first, ...rest],
            subject: subject.value,
            ...(cc.length ? { cc } : {}),
            ...(bcc.length ? { bcc } : {}),
            ...content,
          },
          { idempotencyKey: Option.getOrUndefined(idempotencyKey) },
        ).pipe(
          client.provide,
          Effect.mapError((e) => mailboxApiError("Could not send message", e)),
        );
        if (json) return yield* printJson(result);
        yield* printReceipt(result);
      }),
  ),
);
/** The channel of the message a reply answers; the thread it joins is on the same one. */
const messageChannel = (mailbox: MailboxId, messageId: MessageId) =>
  getMailboxJson("Could not read message", `/v1/mailboxes/${mailbox}/messages/${messageId}`).pipe(
    Effect.flatMap((raw) =>
      Schema.decodeUnknownEffect(Schema.Struct({ channel: channelSchema }))(raw).pipe(
        Effect.mapBoth({
          onSuccess: ({ channel }): Channel => channel,
          onFailure: () =>
            new SamvaCliError({ message: "The API answered with an unreadable message." }),
        }),
      ),
    ),
  );
const reply = Command.make("reply", {
  mailbox: mailboxIdArgument,
  messageId: messageIdArgument,
  ...bodyFlags,
  ...chatOnlyFlags,
  all: Flag.Boolean("all").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Reply to a message; --all includes the other recipients. A WhatsApp or SMS message is answered on its thread, with --text or a WhatsApp --template",
  ),
  Command.withExamples([
    {
      command:
        'samva mailboxes reply mbx_1234567890123456 msg_1234567890123456 --text "Thanks" --all',
    },
    {
      command:
        "samva mailboxes reply mbx_1234567890123456 msg_1234567890123456 --template tmpl_1234567890123456",
      description: "Answer a WhatsApp thread whose 24-hour service window has closed",
    },
  ]),
  Command.withHandler(
    ({ messageId, mailbox, text, html, template, data, idempotencyKey, all, json }) =>
      Effect.gen(function* () {
        // A template or JSON flag names WhatsApp, html or --all names email; a bare --text could be
        // either, so the message says which channel its thread is on.
        const channel: Channel =
          Option.isSome(template) || Option.isSome(data)
            ? "whatsapp"
            : Option.isSome(html) || all || Option.isNone(text)
              ? "email"
              : yield* messageChannel(mailbox, messageId);
        if (channel !== "email") {
          if (all)
            return yield* usage(
              "mailbox_chat_all",
              "--all is for email; a chat reply has one recipient.",
            );
          const content = yield* chatContent(channel, { text, html, template, data });
          const raw = yield* postMailboxJson(
            "Could not reply",
            `/v1/mailboxes/${mailbox}/messages/${messageId}/reply`,
            { channel, ...content },
            keyHeader(idempotencyKey),
          );
          if (json) return yield* printJson(raw);
          return yield* printReceipt(yield* decodeReceipt(raw));
        }
        const payload = yield* body(text, html);
        const client = yield* getClientProvider;
        const result = yield* (all ? Mailboxes.replyAll : Mailboxes.reply)(
          {
            id: mailbox,
            messageId,
            ...payload,
          },
          { idempotencyKey: Option.getOrUndefined(idempotencyKey) },
        ).pipe(
          client.provide,
          Effect.mapError((e) => mailboxApiError("Could not reply", e)),
        );
        if (json) return yield* printJson(result);
        yield* printReceipt(result);
      }),
  ),
);
const actionIdArgument = Argument.String("action-id").pipe(Argument.withSchema(MailboxActionId));
const actionGet = deriveOverride(
  "get",
  { mailbox: mailboxIdArgument, actionId: actionIdArgument, json: jsonFlag },
  {
    mapInput: ({ mailbox, actionId }) => ({ id: mailbox, actionId }),
    call: (request) => Mailboxes.getAction(request),
    failure: "Could not read action",
    render: (data) => printAction(data),
  },
).pipe(Command.withDescription("Read a mailbox action and its current send progress"));
const actionCancel = deriveOverride(
  "cancel",
  { mailbox: mailboxIdArgument, actionId: actionIdArgument, json: jsonFlag },
  {
    mapInput: ({ mailbox, actionId }) => ({ id: mailbox, actionId }),
    call: (request) => Mailboxes.cancelAction(request),
    failure: (error) => mailboxApiError("Could not cancel action", error, { personOnly: "cancel" }),
    render: (data) =>
      printFields([
        ["Action", data.actionId],
        ["State", data.state],
        ["Message", data.messageId],
      ]),
  },
).pipe(
  Command.withDescription(
    "Cancel an unaccepted send as a permitted person signed in with samva login",
  ),
);
const actionRetry = deriveOverride(
  "retry",
  { mailbox: mailboxIdArgument, actionId: actionIdArgument, json: jsonFlag },
  {
    mapInput: ({ mailbox, actionId }) => ({ id: mailbox, actionId }),
    call: (request) => Mailboxes.retryAction(request),
    failure: (error) => mailboxApiError("Could not retry action", error, { personOnly: "retry" }),
    render: (data) =>
      printFields([
        ["Action", data.actionId],
        ["State", data.state],
        ["Retry at", data.retryAt],
      ]),
  },
).pipe(
  Command.withDescription(
    "Resume an eligible queued send as a permitted person; preserves content, retry delays and deadline",
  ),
);
const quarantineList = deriveOverride(
  "list",
  {
    mailbox: mailboxIdArgument,
    ...pageFlags,
    after: instantFlag("after", "Only messages held after this ISO 8601 instant"),
    before: instantFlag("before", "Only messages held before this ISO 8601 instant"),
    json: jsonFlag,
  },
  {
    mapInput: ({ mailbox, limit, cursor, after, before }) => ({
      id: mailbox,
      cursor: Option.getOrUndefined(cursor),
      limit: Option.getOrUndefined(limit),
      after: Option.getOrUndefined(after),
      before: Option.getOrUndefined(before),
    }),
    call: (request) => Mailboxes.listSpamHeld(request),
    failure: "Could not list held mail",
    paginate: {
      withCursor: (request, cursor) => ({ ...request, cursor }),
      start: (request) => request.cursor,
      stopOnEmpty: true,
    },
    render: (data) =>
      Effect.gen(function* () {
        if (data.items.length === 0) yield* Console.log("No messages held for malware.");
        for (const item of data.items) yield* printHeldMessage(item);
        if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
      }),
  },
).pipe(
  Command.withDescription("List held messages without their bodies"),
  Command.withExamples([
    { command: "samva mailboxes spam list mbx_1234567890123456 --json" },
    { command: "samva mailboxes spam list mbx_1234567890123456 --all --jsonl" },
  ]),
);
const discard = deriveOverride(
  "discard",
  {
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
    mailbox: mailboxIdArgument,
    messageId: messageIdArgument,
    json: jsonFlag,
  },
  {
    mapInput: ({ mailbox, messageId }) => ({ id: mailbox, messageId }),
    call: (request) => Mailboxes.discardSpamHeld(request),
    failure: (error) =>
      mailboxApiError("Could not discard message", error, { personOnly: "discard" }),
    preview: {
      data: (request) => ({
        dryRun: true,
        action: "mailboxes.spam.discard",
        id: request.id,
        messageId: request.messageId,
      }),
      render: (request) =>
        Console.log(`[dry-run] Would permanently discard held message ${request.messageId}.`),
    },
    confirmation: (request) => ({
      message: `Permanently discard held message ${request.messageId}?`,
      nonInteractiveMessage:
        "Discarding held mail requires --yes in non-interactive mode. Preview with --dry-run.",
    }),
    render: (data) => printHeldMessage(data),
  },
).pipe(
  Command.withDescription("Discard a held message for good as a person signed in with samva login"),
  Command.withExamples([
    {
      command: "samva mailboxes spam discard mbx_1234567890123456 msg_1234567890123456",
    },
  ]),
);
export const mailboxesCommand = Command.make("mailboxes").pipe(
  Command.withDescription("Mailbox reading and governed sending"),
  Command.withSubcommands([
    mailboxesEventsCommand,
    mailboxesImportCommand,
    mailboxesImportStatusCommand,
    list,
    create,
    get,
    update,
    lifecycle("pause"),
    lifecycle("resume"),
    Command.make("endpoints").pipe(
      Command.withSubcommands([endpointAdd, endpointUpdate, endpointRemove]),
    ),
    Command.make("actions").pipe(
      Command.withSubcommands([
        actionsList,
        actionDecision("approve"),
        actionDecision("deny"),
        actionGet,
        actionCancel,
        actionRetry,
      ]),
    ),
    remove,
    threads.pipe(Command.withSubcommands([deleteThread])),
    Command.make("trash").pipe(Command.withSubcommands([emptyFolder("trash")])),
    allThreads,
    needsYou,
    threadUpdate,
    read,
    send,
    reply,
    Command.make("spam").pipe(
      Command.withSubcommands([quarantineList, discard, emptyFolder("spam")]),
    ),
  ]),
);
