import { MailboxActionState } from "@samva/core/mailboxes/action-event-policy";
import { UpdateMailboxPayload } from "@samva/core/mailboxes/resource";
import { MailboxThreadFolder } from "@samva/core/mailboxes/thread";
import {
  MailboxActionId,
  MailboxEndpointId,
  MailboxId,
  MailboxLabelId,
  MessageId,
  NamespaceId,
  TemplateId,
} from "@samva/core/shared/base";
import { Cursor } from "@samva/core/shared/cursor";
import { Console, Effect, FileSystem, Option, Predicate, Schema } from "effect";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { identity } from "effect/Function";
import * as References from "effect/References";
import * as Mailboxes from "samva/effect/mailboxes";

import { CliUsageError, SamvaCliError } from "../errors";
import { getClientProvider } from "../lib/client";
import { confirmDestructive } from "../lib/confirm";
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
  getMailboxJson,
  postMailboxJson,
} from "../lib/mailbox-wire";
import { jsonFlag, printFields, printJson, printJsonLine } from "../lib/output";
import { isJsonLinesRequested } from "../lib/runtime";
import { mailboxesEventsCommand } from "./mailboxes-events";

const mailboxIdArgument = Argument.String("mailbox-id").pipe(Argument.withSchema(MailboxId));
const messageIdArgument = Argument.String("message-id").pipe(Argument.withSchema(MessageId));
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
const channelFlag = Flag.Literals("channel", ["email", "whatsapp", "sms"]).pipe(
  Flag.withDescription("The channel: email, or a connected whatsapp or sms number"),
  Flag.withDefault("email"),
);
type Channel = "email" | "whatsapp" | "sms";
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
    ? // @effect-diagnostics-next-line effectSucceedWithVoid:off -- undefined is a real success value (no cursor), not a void outcome; Effect.void is not assignable to `string | undefined`.
      Effect.succeed(undefined)
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
const searchParams = (values: Readonly<Record<string, string | number | boolean | undefined>>) => {
  const query = new URLSearchParams(
    Object.entries(values).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, String(value)]],
    ),
  ).toString();
  return query === "" ? "" : `?${query}`;
};

interface Page<Item> {
  readonly items: ReadonlyArray<Item>;
  readonly nextCursor: string | null;
}

/**
 * Prints one page, or streams pages as JSONL. `--all` follows `nextCursor` until the API returns
 * none and stops when the API repeats a cursor, so a server bug cannot loop forever.
 */
const followPages = <Item, E, R>(options: {
  readonly all: boolean;
  readonly json: boolean;
  readonly cursor: Option.Option<string>;
  readonly page: (cursor: string | undefined) => Effect.Effect<Page<Item>, E, R>;
  readonly empty: string;
  readonly human: (item: Item) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    if (options.all && !isJsonLinesRequested())
      return yield* new CliUsageError({
        code: "all_requires_jsonl",
        message: "--all is an unbounded traversal and requires --jsonl.",
      });
    let cursor = yield* checkCursor(Option.getOrUndefined(options.cursor));
    if (!isJsonLinesRequested()) {
      const data = yield* options.page(cursor);
      if (options.json) return yield* printJson(data);
      if (!data.items.length) yield* Console.log(options.empty);
      for (const item of data.items) yield* options.human(item);
      if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
      return;
    }
    const seen = new Set<string>();
    for (;;) {
      const data = yield* options.page(cursor);
      for (const item of data.items) yield* printJsonLine(item);
      if (!options.all || data.nextCursor === null || data.items.length === 0) return;
      if (seen.has(data.nextCursor))
        return yield* new SamvaCliError({
          message: "The API repeated a pagination cursor; traversal stopped.",
        });
      seen.add(data.nextCursor);
      cursor = data.nextCursor;
    }
  });

const list = Command.make("list", {
  ...pageFlags,
  after: instantFlag("after", "Only mailboxes created after this ISO 8601 instant"),
  before: instantFlag("before", "Only mailboxes created before this ISO 8601 instant"),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List mailboxes the caller can read"),
  Command.withExamples([
    { command: "samva mailboxes list --json" },
    { command: "samva mailboxes list --all --jsonl", description: "Stream every page as JSONL" },
  ]),
  Command.withHandler(({ limit, cursor, all, after, before, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      yield* followPages({
        all,
        json,
        cursor,
        page: (pageCursor) =>
          Mailboxes.list({
            cursor: pageCursor,
            limit: Option.getOrUndefined(limit),
            after: Option.getOrUndefined(after),
            before: Option.getOrUndefined(before),
          }).pipe(
            client.provide,
            Effect.mapError((e) => mailboxApiError("Could not list mailboxes", e)),
          ),
        empty: "No mailboxes found.",
        human: printMailboxSummary,
      });
    }),
  ),
);
const create = Command.make("create", {
  channel: channelFlag,
  address: Flag.String("address").pipe(
    Flag.withDescription(
      "The mailbox's address: an email address such as support@acme.samva.email, or on whatsapp and sms a number you connected, in E.164 form such as +14155550123",
    ),
  ),
  name: Flag.String("name"),
  slug: Flag.String("slug").pipe(
    Flag.withDescription("Defaults to the address's local part, or a phone number's digits"),
    Flag.optional,
  ),
  namespace: Flag.String("namespace").pipe(Flag.withSchema(NamespaceId), Flag.optional),
  json: jsonFlag,
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
  Command.withHandler(({ channel, address, name, slug, namespace, json }) =>
    Effect.gen(function* () {
      if (channel !== "email") {
        const raw = yield* postMailboxJson("Could not create mailbox", "/v1/mailboxes", {
          endpoint: { channel, address },
          name,
          ...(Option.isSome(slug) ? { slug: slug.value } : {}),
          ...(Option.isSome(namespace) ? { namespaceId: namespace.value } : {}),
        });
        if (json) return yield* printJson(raw);
        return yield* printMailbox(yield* decodeMailbox(raw));
      }
      const client = yield* getClientProvider;
      const data = yield* Mailboxes.create({
        endpoint: { channel: "email", address },
        name,
        slug: Option.getOrUndefined(slug),
        namespaceId: Option.getOrUndefined(namespace),
      }).pipe(
        client.provide,
        Effect.mapError((e) => mailboxApiError("Could not create mailbox", e)),
      );
      if (json) return yield* printJson(data);
      yield* printMailbox(data);
    }),
  ),
);
const get = Command.make("get", { id: mailboxIdArgument, json: jsonFlag }).pipe(
  Command.withDescription("Inspect a mailbox's endpoints and settings"),
  Command.withHandler(({ id, json }) =>
    Effect.gen(function* () {
      const raw = yield* getMailboxJson("Could not read mailbox", `/v1/mailboxes/${id}`);
      const result = yield* decodeMailbox(raw);
      yield* json ? printJson(raw) : printMailbox(result);
    }),
  ),
);
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
const endpointAdd = Command.make("add", {
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
  Command.withHandler(({ mailbox, channel, address, displayName, dryRun, json }) =>
    Effect.gen(function* () {
      const payload = {
        channel,
        address,
        displayName: Option.getOrUndefined(displayName),
      } as const;
      if (dryRun)
        return yield* json
          ? printJson({
              dryRun: true,
              action: "mailboxes.createEndpoint",
              id: mailbox,
              request: payload,
            })
          : Console.log(`[dry-run] Would add ${address} to mailbox ${mailbox}.`);
      if (channel !== "email") {
        const raw = yield* postMailboxJson(
          "Could not add the endpoint",
          `/v1/mailboxes/${mailbox}/endpoints`,
          payload,
        );
        if (json) return yield* printJson(raw);
        return yield* printMailbox(yield* decodeMailbox(raw));
      }
      const client = yield* getClientProvider;
      const result = yield* Mailboxes.createEndpoint({
        id: mailbox,
        ...payload,
        channel: "email",
      }).pipe(
        client.provide,
        Effect.mapError((e) => mailboxApiError("Could not add the endpoint", e)),
      );
      yield* json ? printJson(result) : printMailbox(result);
    }),
  ),
);
const endpointIdArgument = Argument.String("endpoint-id").pipe(
  Argument.withSchema(MailboxEndpointId),
);
const endpointUpdate = Command.make("update", {
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
}).pipe(
  Command.withDescription("Rename an endpoint's sender or make it the mailbox's default"),
  Command.withExamples([
    {
      command:
        'samva mailboxes endpoints update mbx_1234567890123456 mbxep_1234567890123456 --display-name "Acme Billing" --default',
    },
  ]),
  Command.withHandler(
    ({ endpointId, mailbox, displayName, clearDisplayName, makeDefault, dryRun, json }) =>
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
        const payload = {
          ...(Option.isSome(displayName)
            ? { displayName: displayName.value }
            : clearDisplayName
              ? { displayName: null }
              : {}),
          ...(makeDefault ? { default: true as const } : {}),
        };
        if (dryRun)
          return yield* json
            ? printJson({
                dryRun: true,
                action: "mailboxes.updateEndpoint",
                id: mailbox,
                endpointId,
                request: payload,
              })
            : Console.log(`[dry-run] Would update endpoint ${endpointId} of mailbox ${mailbox}.`);
        const client = yield* getClientProvider;
        const result = yield* Mailboxes.updateEndpoint({
          id: mailbox,
          endpointId,
          ...payload,
        }).pipe(
          client.provide,
          Effect.mapError((e) => mailboxApiError("Could not update the endpoint", e)),
        );
        yield* json ? printJson(result) : printMailbox(result);
      }),
  ),
);
const endpointRemove = Command.make("remove", {
  mailbox: mailboxIdArgument,
  endpointId: endpointIdArgument,
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Remove an endpoint from a mailbox; mail sent to it stops reaching the mailbox",
  ),
  Command.withExamples([
    {
      command: "samva mailboxes endpoints remove mbx_1234567890123456 mbxep_1234567890123456 --yes",
    },
  ]),
  Command.withHandler(({ endpointId, mailbox, dryRun, yes, json }) =>
    Effect.gen(function* () {
      if (dryRun)
        return yield* json
          ? printJson({
              dryRun: true,
              action: "mailboxes.removeEndpoint",
              id: mailbox,
              endpointId,
            })
          : Console.log(`[dry-run] Would remove endpoint ${endpointId} from mailbox ${mailbox}.`);
      yield* confirmDestructive({
        yes,
        json,
        message: `Remove endpoint ${endpointId} from mailbox ${mailbox}? Mail sent to it will stop reaching the mailbox.`,
        nonInteractiveMessage:
          "Removing an endpoint requires --yes in non-interactive mode. Preview with --dry-run.",
      });
      const client = yield* getClientProvider;
      const result = yield* Mailboxes.removeEndpoint({ id: mailbox, endpointId }).pipe(
        client.provide,
        Effect.mapError((e) => mailboxApiError("Could not remove the endpoint", e)),
      );
      yield* json ? printJson(result) : printMailbox(result);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
const lifecycle = (verb: "pause" | "resume") =>
  Command.make(verb, {
    id: mailboxIdArgument,
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    json: jsonFlag,
  }).pipe(
    Command.withDescription(
      verb === "pause"
        ? "Pause sending and inbound delivery; mail arriving while paused is not backfilled"
        : "Resume mailbox delivery",
    ),
    Command.withHandler(({ id, dryRun, json }) =>
      Effect.gen(function* () {
        if (dryRun)
          return yield* json
            ? printJson({ dryRun: true, action: `mailboxes.${verb}`, id })
            : Console.log(`[dry-run] Would ${verb} mailbox ${id}.`);
        const client = yield* getClientProvider;
        const result = yield* Mailboxes[verb]({ id }).pipe(
          client.provide,
          Effect.mapError((e) => mailboxApiError(`Could not ${verb} mailbox`, e)),
        );
        yield* json ? printJson(result) : printMailbox(result);
      }),
    ),
  );
const actionsList = Command.make("list", {
  mailbox: mailboxIdArgument,
  ...pageFlags,
  state: Flag.Literals("state", MailboxActionState.literals).pipe(Flag.optional),
  after: instantFlag("after", "Only actions created after this ISO 8601 instant"),
  before: instantFlag("before", "Only actions created before this ISO 8601 instant"),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List mailbox actions and their policy decisions"),
  Command.withHandler(({ mailbox, limit, cursor, all, state, after, before, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      yield* followPages({
        all,
        json,
        cursor,
        page: (pageCursor) =>
          Mailboxes.listActions({
            id: mailbox,
            limit: Option.getOrUndefined(limit),
            cursor: pageCursor,
            state: Option.getOrUndefined(state),
            after: Option.getOrUndefined(after),
            before: Option.getOrUndefined(before),
          }).pipe(
            client.provide,
            Effect.mapError((e) => mailboxApiError("Could not list actions", e)),
          ),
        empty: "No mailbox actions found.",
        human: printAction,
      });
    }),
  ),
);
const actionDecision = (verb: "approve" | "deny") =>
  Command.make(verb, {
    mailbox: mailboxIdArgument,
    actionId: Argument.String("action-id").pipe(Argument.withSchema(MailboxActionId)),
    ...(verb === "deny"
      ? {
          reason: optional("reason").pipe(
            Flag.withDescription("Denial reason; defaults to Denied by reviewer."),
          ),
        }
      : {}),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
    json: jsonFlag,
  }).pipe(
    Command.withDescription(
      `${verb === "approve" ? "Approve and execute" : "Deny"} an action as a signed-in person other than its proposer`,
    ),
    Command.withHandler(({ actionId, mailbox, reason, dryRun, yes, json }) =>
      Effect.gen(function* () {
        const denialReason =
          reason === undefined ? undefined : Option.getOrElse(reason, () => "Denied by reviewer.");
        if (dryRun)
          return yield* json
            ? printJson({
                dryRun: true,
                action: `mailboxes.actions.${verb}`,
                id: mailbox,
                actionId,
                ...(verb === "deny" ? { reason: denialReason } : {}),
              })
            : Console.log(
                `[dry-run] Would ${verb} mailbox action ${actionId} in mailbox ${mailbox}${
                  verb === "deny" ? ` with reason: ${denialReason}` : ""
                }.`,
              );
        yield* confirmDestructive({
          yes,
          json,
          message: `${verb === "approve" ? "Approve and execute" : "Deny"} mailbox action ${actionId}?`,
          nonInteractiveMessage: `Action ${verb} requires --yes in non-interactive mode. Preview with --dry-run.`,
        });
        const client = yield* getClientProvider;
        const result = yield* (
          verb === "approve"
            ? Mailboxes.approveAction({ id: mailbox, actionId })
            : Mailboxes.denyAction({
                id: mailbox,
                actionId,
                reason: denialReason ?? "Denied by reviewer.",
              })
        ).pipe(
          client.provide,
          Effect.mapError((e) =>
            mailboxApiError(`Could not ${verb} action`, e, { personOnly: verb }),
          ),
        );
        yield* json ? printJson(result) : printAction(result);
      }),
    ),
  );
const remove = Command.make("remove", {
  id: Argument.String("mailbox-id").pipe(Argument.withSchema(MailboxId)),
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Permanently delete a mailbox with its endpoints, threads, drafts, and history",
  ),
  Command.withExamples([
    { command: "samva mailboxes remove mbx_1234567890123456 --dry-run" },
    { command: "samva mailboxes remove mbx_1234567890123456 --yes" },
  ]),
  Command.withHandler(({ id, dryRun, yes, json }) =>
    Effect.gen(function* () {
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "mailboxes.remove", id })
          : Console.log(`[dry-run] Would permanently remove mailbox ${id}.`);
      yield* confirmDestructive({
        yes,
        json,
        message: `Permanently remove mailbox ${id} with its threads, drafts, and history?`,
        nonInteractiveMessage:
          "Permanent mailbox deletion requires --yes in non-interactive mode. Preview with --dry-run.",
      });
      const client = yield* getClientProvider;
      const result = yield* Mailboxes.remove({ id }).pipe(
        client.provide,
        Effect.mapError((e) => mailboxApiError("Could not remove mailbox", e)),
      );
      if (json) return yield* printJson(result);
      yield* Console.log(
        `Removed mailbox ${id}. The messages it received stay with the organization.`,
      );
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
const threads = Command.make("threads", {
  mailbox: mailboxIdArgument,
  ...pageFlags,
  query: optional("query"),
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
  Command.withHandler(
    ({ mailbox, limit, cursor, all, query, folder, label, unread, starred, after, before, json }) =>
      followPages({
        all,
        json,
        cursor,
        page: (pageCursor) =>
          getMailboxJson(
            "Could not list threads",
            `/v1/mailboxes/${mailbox}/threads${searchParams({
              cursor: pageCursor,
              limit: Option.getOrUndefined(limit),
              q: Option.getOrUndefined(query),
              folder: Option.getOrUndefined(folder),
              label: Option.getOrUndefined(label),
              unread: unread ? true : undefined,
              starred: starred ? true : undefined,
              after: Option.getOrUndefined(after),
              before: Option.getOrUndefined(before),
            })}`,
          ).pipe(Effect.flatMap(decodeThreadPage)),
        empty: "No threads found.",
        human: printThread,
      }),
  ),
);
const read = Command.make("read", {
  mailbox: mailboxIdArgument,
  messageId: messageIdArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Read a mailbox message"),
  Command.withExamples([
    { command: "samva mailboxes read mbx_1234567890123456 msg_1234567890123456 --json" },
  ]),
  Command.withHandler(({ messageId, mailbox, json }) =>
    Effect.gen(function* () {
      const raw = yield* getMailboxJson(
        "Could not read message",
        `/v1/mailboxes/${mailbox}/messages/${messageId}`,
      );
      const data = yield* decodeMessage(raw);
      if (json) return yield* printJson(raw);
      yield* printMessage(data);
    }),
  ),
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
      Schema.decodeUnknownEffect(
        Schema.Struct({ channel: Schema.Literals(["email", "whatsapp", "sms"]) }),
      )(raw).pipe(
        Effect.map(({ channel }): Channel => channel),
        Effect.mapError(
          () => new SamvaCliError({ message: "The API answered with an unreadable message." }),
        ),
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
const actionGet = Command.make("get", {
  mailbox: mailboxIdArgument,
  actionId: actionIdArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Read a mailbox action and its current send progress"),
  Command.withHandler(({ actionId, mailbox, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Mailboxes.getAction({ id: mailbox, actionId }).pipe(
        client.provide,
        Effect.mapError((e) => mailboxApiError("Could not read action", e)),
      );
      if (json) return yield* printJson(data);
      yield* printAction(data);
    }),
  ),
);
const actionCancel = Command.make("cancel", {
  mailbox: mailboxIdArgument,
  actionId: actionIdArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Cancel an unaccepted send as a permitted person signed in with samva login",
  ),
  Command.withHandler(({ actionId, mailbox, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Mailboxes.cancelAction({ id: mailbox, actionId }).pipe(
        client.provide,
        Effect.mapError((e) =>
          mailboxApiError("Could not cancel action", e, { personOnly: "cancel" }),
        ),
      );
      if (json) return yield* printJson(data);
      yield* printFields([
        ["Action", data.actionId],
        ["State", data.state],
        ["Message", data.messageId],
      ]);
    }),
  ),
);
const actionRetry = Command.make("retry", {
  mailbox: mailboxIdArgument,
  actionId: actionIdArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Resume an eligible ended execution as a permitted person; preserves content and deadline",
  ),
  Command.withHandler(({ actionId, mailbox, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Mailboxes.retryAction({ id: mailbox, actionId }).pipe(
        client.provide,
        Effect.mapError((e) =>
          mailboxApiError("Could not retry action", e, { personOnly: "retry" }),
        ),
      );
      if (json) return yield* printJson(data);
      yield* printFields([
        ["Action", data.actionId],
        ["State", data.state],
        ["Retry at", data.retryAt],
      ]);
    }),
  ),
);
const quarantineList = Command.make("list", {
  mailbox: mailboxIdArgument,
  ...pageFlags,
  after: instantFlag("after", "Only messages held after this ISO 8601 instant"),
  before: instantFlag("before", "Only messages held before this ISO 8601 instant"),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List held messages without their bodies"),
  Command.withExamples([
    { command: "samva mailboxes quarantine list mbx_1234567890123456 --json" },
    { command: "samva mailboxes quarantine list mbx_1234567890123456 --all --jsonl" },
  ]),
  Command.withHandler(({ mailbox, limit, cursor, all, after, before, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      yield* followPages({
        all,
        json,
        cursor,
        page: (pageCursor) =>
          Mailboxes.listQuarantine({
            id: mailbox,
            cursor: pageCursor,
            limit: Option.getOrUndefined(limit),
            after: Option.getOrUndefined(after),
            before: Option.getOrUndefined(before),
          }).pipe(
            client.provide,
            Effect.mapError((e) => mailboxApiError("Could not list quarantine", e)),
          ),
        empty: "No quarantined messages found.",
        human: printHeldMessage,
      });
    }),
  ),
);
const release = Command.make("release", {
  mailbox: mailboxIdArgument,
  messageId: messageIdArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Release a held message as a person signed in with samva login"),
  Command.withExamples([
    {
      command: "samva mailboxes quarantine release mbx_1234567890123456 msg_1234567890123456",
    },
  ]),
  Command.withHandler(({ messageId, mailbox, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Mailboxes.releaseMessage({ id: mailbox, messageId }).pipe(
        client.provide,
        Effect.mapError((e) =>
          mailboxApiError("Could not release message", e, { personOnly: "release" }),
        ),
      );
      if (json) return yield* printJson(data);
      yield* printHeldMessage(data);
    }),
  ),
);
const discard = Command.make("discard", {
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
  mailbox: mailboxIdArgument,
  messageId: messageIdArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Discard a held message for good as a person signed in with samva login"),
  Command.withExamples([
    {
      command: "samva mailboxes quarantine discard mbx_1234567890123456 msg_1234567890123456",
    },
  ]),
  Command.withHandler(({ messageId, mailbox, dryRun, yes, json }) =>
    Effect.gen(function* () {
      if (dryRun)
        return yield* json
          ? printJson({
              dryRun: true,
              action: "mailboxes.quarantine.discard",
              id: mailbox,
              messageId,
            })
          : Console.log(`[dry-run] Would permanently discard held message ${messageId}.`);
      yield* confirmDestructive({
        yes,
        json,
        message: `Permanently discard held message ${messageId}?`,
        nonInteractiveMessage:
          "Discarding held mail requires --yes in non-interactive mode. Preview with --dry-run.",
      });
      const client = yield* getClientProvider;
      const data = yield* Mailboxes.discardMessage({ id: mailbox, messageId }).pipe(
        client.provide,
        Effect.mapError((e) =>
          mailboxApiError("Could not discard message", e, { personOnly: "discard" }),
        ),
      );
      if (json) return yield* printJson(data);
      yield* printHeldMessage(data);
    }),
  ),
);
export const mailboxesCommand = Command.make("mailboxes").pipe(
  Command.withDescription("Mailbox reading and governed sending"),
  Command.withSubcommands([
    mailboxesEventsCommand,
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
    threads,
    read,
    send,
    reply,
    Command.make("quarantine").pipe(Command.withSubcommands([quarantineList, release, discard])),
  ]),
);
