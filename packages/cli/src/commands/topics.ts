import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Topics from "samva/effect/topics";

import { CliUsageError, toCliApiError } from "../errors";
import { getClientProvider } from "../lib/client";
import { confirmDestructive } from "../lib/confirm";
import { jsonFlag, printFields, printJson, printJsonLine } from "../lib/output";
import { isJsonLinesRequested } from "../lib/runtime";

const idArgument = Argument.String("id").pipe(Argument.withDescription("Topic id (unsub_...)"));
const optionalString = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.optional);
const dryRunFlag = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Preview the request without calling the API"),
  Flag.withDefault(false),
);
const channelFlag = Flag.Literals("channel", ["email"]).pipe(
  Flag.withDescription("Subscription channel"),
);
const statusFlag = Flag.Literals("status", ["subscribed", "unsubscribed"]).pipe(
  Flag.withDescription("Explicit subscription status"),
);
const defaultFlag = Flag.Literals("default", ["opt_in", "opt_out"]).pipe(
  Flag.withDescription("Eligibility without an explicit subscription: opt_in requires subscribed"),
  Flag.optional,
);
const publishingFlags = {
  description: optionalString("description", "Description; pass none to clear"),
  defaultSenderId: optionalString("default-sender-id", "Default sender id; pass none to clear"),
  replyMailboxId: optionalString("reply-mailbox-id", "Reply mailbox id; pass none to clear"),
  templateId: optionalString("template-id", "Default template id; pass none to clear"),
};
const nullableValue = (value: Option.Option<string>) =>
  Option.match(value, {
    onNone: () => undefined,
    onSome: (text) => (text === "none" ? null : text),
  });
const topicFields = (topic: {
  readonly id: string;
  readonly name: string;
  readonly namespaceId: string | null;
  readonly description: string | null;
  readonly default: string;
  readonly isDefault: boolean;
  readonly defaultSenderId: string | null;
  readonly replyMailboxId: string | null;
  readonly templateId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}) =>
  printFields([
    ["ID", topic.id],
    ["Name", topic.name],
    ["Namespace", topic.namespaceId ?? "organization"],
    ["Description", topic.description],
    ["Default eligibility", topic.default],
    ["Organization default", topic.isDefault ? "yes" : "no"],
    ["Default sender", topic.defaultSenderId],
    ["Reply mailbox", topic.replyMailboxId],
    ["Template", topic.templateId],
    ["Created", topic.createdAt],
    ["Updated", topic.updatedAt],
  ]);

const list = Command.make("list", {
  namespaceId: optionalString("namespace-id", "Limit to one namespace"),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List topics, default first (bounded by the organization's topic limit)"),
  Command.withExamples([{ command: "samva topics list --json" }]),
  Command.withHandler(({ namespaceId, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Topics.list({ namespaceId: Option.getOrUndefined(namespaceId) }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not list topics", error)),
      );
      if (json) return yield* printJson(data);
      if (data.items.length === 0) return yield* Console.log("No topics found.");
      for (const topic of data.items) yield* topicFields(topic);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
const get = Command.make("get", { id: idArgument, json: jsonFlag }).pipe(
  Command.withDescription("Read a topic and its publishing defaults"),
  Command.withExamples([{ command: "samva topics get unsub_1234567890abcdef --json" }]),
  Command.withHandler(({ id, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Topics.get({ id }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not get topic", error)),
      );
      if (json) return yield* printJson(data);
      yield* topicFields(data);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
const create = Command.make("create", {
  name: Flag.String("name").pipe(Flag.withDescription("Topic name")),
  namespaceId: optionalString("namespace-id", "Namespace for the topic and its contacts"),
  default: defaultFlag,
  ...publishingFlags,
  dryRun: dryRunFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create a topic with per-channel subscription preferences"),
  Command.withExamples([
    { command: "samva topics create --name Newsletter --default opt_in --json" },
  ]),
  Command.withHandler(
    ({
      name,
      namespaceId,
      default: eligibility,
      description,
      defaultSenderId,
      replyMailboxId,
      templateId,

      dryRun,
      json,
    }) =>
      Effect.gen(function* () {
        const request = {
          name,
          namespaceId: Option.getOrUndefined(namespaceId),
          default: Option.getOrUndefined(eligibility),
          description: nullableValue(description),
          defaultSenderId: nullableValue(defaultSenderId),
          replyMailboxId: nullableValue(replyMailboxId),
          templateId: nullableValue(templateId),
        };
        if (dryRun)
          return yield* json
            ? printJson({ dryRun, action: "topics.create", request })
            : Console.log(JSON.stringify(request));
        const client = yield* getClientProvider;
        const data = yield* Topics.create(request).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError("Could not create topic", error)),
        );
        if (json) return yield* printJson(data);
        yield* topicFields(data);
      }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
const update = Command.make("update", {
  id: idArgument,
  name: optionalString("name", "New topic name"),
  default: defaultFlag,
  ...publishingFlags,
  dryRun: dryRunFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Update a topic; changing its default preserves explicit subscriptions"),
  Command.withExamples([
    { command: "samva topics update unsub_1234567890abcdef --name Updates --default opt_out" },
  ]),
  Command.withHandler(
    ({
      id,
      name,
      default: eligibility,
      description,
      defaultSenderId,
      replyMailboxId,
      templateId,

      dryRun,
      json,
    }) =>
      Effect.gen(function* () {
        if (
          [name, eligibility, description, defaultSenderId, replyMailboxId, templateId].every(
            Option.isNone,
          )
        )
          return yield* new CliUsageError({
            code: "nothing_to_update",
            message: "Pass a field to change. Run `samva topics update --help`.",
          });
        const request = {
          id,
          name: Option.getOrUndefined(name),
          default: Option.getOrUndefined(eligibility),
          description: nullableValue(description),
          defaultSenderId: nullableValue(defaultSenderId),
          replyMailboxId: nullableValue(replyMailboxId),
          templateId: nullableValue(templateId),
        };
        if (dryRun)
          return yield* json
            ? printJson({ dryRun, action: "topics.update", request })
            : Console.log(JSON.stringify(request));
        const client = yield* getClientProvider;
        const data = yield* Topics.update(request).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError("Could not update topic", error)),
        );
        if (json) return yield* printJson(data);
        yield* topicFields(data);
      }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
const remove = Command.make("remove", {
  id: idArgument,
  dryRun: dryRunFlag,
  yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Delete a topic; default topics and topics used by active campaigns are refused",
  ),
  Command.withExamples([
    { command: "samva topics remove unsub_1234567890abcdef --dry-run --json" },
  ]),
  Command.withHandler(({ id, dryRun, yes, json }) =>
    Effect.gen(function* () {
      if (dryRun)
        return yield* json
          ? printJson({ dryRun, action: "topics.remove", id })
          : Console.log(`[dry-run] Would remove topic ${id}.`);
      yield* confirmDestructive({
        yes,
        json,
        message: `Remove topic ${id} and its subscriptions?`,
        nonInteractiveMessage:
          "Topic removal requires --yes outside a terminal. Preview with --dry-run.",
      });
      const client = yield* getClientProvider;
      const data = yield* Topics.remove({ id }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not remove topic", error)),
      );
      if (json) return yield* printJson(data);
      yield* Console.log(`Removed topic ${id}.`);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
const setDefault = Command.make("default", {
  id: idArgument,
  dryRun: dryRunFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Select the organization's default topic"),
  Command.withExamples([{ command: "samva topics default unsub_1234567890abcdef --json" }]),
  Command.withHandler(({ id, dryRun, json }) =>
    Effect.gen(function* () {
      if (dryRun)
        return yield* json
          ? printJson({ dryRun, action: "topics.setDefault", id })
          : Console.log(`[dry-run] Would set default topic ${id}.`);
      const client = yield* getClientProvider;
      const data = yield* Topics.setDefault({ id }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not set default topic", error)),
      );
      if (json) return yield* printJson(data);
      yield* topicFields(data);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
const listSubscriptions = Command.make("list", {
  id: idArgument,
  channel: channelFlag.pipe(Flag.optional),
  status: statusFlag.pipe(Flag.optional),
  limit: Flag.Int("limit").pipe(Flag.withDescription("Items per page"), Flag.optional),
  cursor: optionalString("cursor", "Resume from nextCursor"),
  all: Flag.Boolean("all").pipe(
    Flag.withDescription("Stream every page; requires --jsonl"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List explicit topic subscriptions; absent rows use the topic default"),
  Command.withExamples([
    { command: "samva topics subscriptions list unsub_1234567890abcdef --channel email --json" },
  ]),
  Command.withHandler(({ id, channel, status, limit, cursor, all, json }) =>
    Effect.gen(function* () {
      if (all && !isJsonLinesRequested())
        return yield* new CliUsageError({
          code: "all_requires_jsonl",
          message: "--all requires --jsonl. Omit --all for one bounded page.",
        });
      const client = yield* getClientProvider;
      let nextCursor = Option.getOrUndefined(cursor);
      for (;;) {
        const data = yield* Topics.listSubscriptions({
          id,
          channel: Option.getOrUndefined(channel),
          status: Option.getOrUndefined(status),
          limit: Option.getOrUndefined(limit),
          cursor: nextCursor,
        }).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError("Could not list topic subscriptions", error)),
        );
        if (isJsonLinesRequested()) {
          for (const item of data.items) yield* printJsonLine(item);
        } else if (json) return yield* printJson(data);
        else {
          if (data.items.length === 0) yield* Console.log("No explicit subscriptions found.");
          for (const item of data.items)
            yield* printFields([
              ["Contact", item.contactId],
              ["Channel", item.channel],
              ["Status", item.status],
              ["Source", item.source],
              ["Subscribed", item.subscribedAt],
              ["Unsubscribed", item.unsubscribedAt],
              ["Created", item.createdAt],
              ["Updated", item.updatedAt],
            ]);
          if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
        }
        if (!all || data.nextCursor === null) return;
        nextCursor = data.nextCursor;
      }
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
const setSubscriptions = Command.make("set", {
  id: idArgument,
  channel: channelFlag,
  status: statusFlag,
  contactIds: Flag.String("contact-id").pipe(
    Flag.withDescription("Contact id (repeatable)"),
    Flag.atLeast(0),
  ),
  emails: Flag.String("email").pipe(
    Flag.withDescription(
      "Email address (repeatable); creates a missing contact in the topic namespace",
    ),
    Flag.atLeast(0),
  ),
  phones: Flag.String("phone").pipe(
    Flag.withDescription(
      "Phone address (repeatable); creates a missing contact in the topic namespace",
    ),
    Flag.atLeast(0),
  ),
  source: optionalString("source", "Origin of this subscription change"),
  dryRun: dryRunFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Set explicit subscribed or unsubscribed status for one channel; retries are idempotent",
  ),
  Command.withExamples([
    {
      command:
        "samva topics subscriptions set unsub_1234567890abcdef --email ada@example.com --channel email --status subscribed --source import --json",
    },
  ]),
  Command.withHandler(({ id, channel, status, contactIds, emails, phones, source, dryRun, json }) =>
    Effect.gen(function* () {
      const contacts = [
        ...contactIds.map((contactId) => ({ contactId })),
        ...emails.map((email) => ({ email })),
        ...phones.map((phone) => ({ phone })),
      ];
      if (contacts.length === 0 || contacts.length > 1000)
        return yield* new CliUsageError({
          code: "invalid_contact_count",
          message: "Pass 1–1000 contacts using repeatable --contact-id, --email, or --phone.",
        });
      const request = { id, contacts, channel, status, source: Option.getOrUndefined(source) };
      if (dryRun)
        return yield* json
          ? printJson({ dryRun, action: "topics.setSubscriptions", request })
          : Console.log(
              `[dry-run] Would set ${contacts.length} ${channel} subscriptions to ${status} for ${id}.`,
            );
      const client = yield* getClientProvider;
      const data = yield* Topics.setSubscriptions(request).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not set topic subscriptions", error)),
      );
      if (json) return yield* printJson(data);
      yield* printFields([["Updated", data.updated]]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
const check = Command.make("check", {
  contactId: optionalString("contact-id", "Contact id; choose exactly one identifier"),
  email: optionalString("email", "Email address"),
  phone: optionalString("phone", "Phone address"),
  namespaceId: optionalString("namespace-id", "Namespace in which to resolve the address"),
  channel: channelFlag,
  topicIds: Flag.String("topic-id").pipe(
    Flag.withDescription("Topic to check (repeatable); omit for all visible topics"),
    Flag.atLeast(0),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Check effective subscription status, including topic defaults"),
  Command.withExamples([
    { command: "samva topics subscriptions check --email ada@example.com --channel email --json" },
  ]),
  Command.withHandler(({ contactId, email, phone, namespaceId, channel, topicIds, json }) =>
    Effect.gen(function* () {
      if ([contactId, email, phone].filter(Option.isSome).length !== 1)
        return yield* new CliUsageError({
          code: "contact_identifier_required",
          message: "Pass exactly one of --contact-id, --email, or --phone.",
        });
      const client = yield* getClientProvider;
      const data = yield* Topics.checkSubscription({
        contactId: Option.getOrUndefined(contactId),
        email: Option.getOrUndefined(email),
        phone: Option.getOrUndefined(phone),
        namespaceId: Option.getOrUndefined(namespaceId),
        channel,
        topicIds: topicIds.length === 0 ? undefined : topicIds.join(","),
      }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not check topic subscriptions", error)),
      );
      if (json) return yield* printJson(data);
      yield* printFields([
        ["Contact", data.contactId ?? "unknown address"],
        ["Channel", data.channel],
      ]);
      for (const topic of data.topics)
        yield* printFields([
          ["Topic", topic.topicId],
          ["Name", topic.topicName],
          ["Status", topic.status],
        ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
const subscriptions = Command.make("subscriptions").pipe(
  Command.withDescription("Read effective preferences and write explicit per-channel status"),
  Command.withExamples([
    { command: "samva topics subscriptions check --email ada@example.com --channel email --json" },
  ]),
  Command.withSubcommands([listSubscriptions, setSubscriptions, check]),
);
export const topicsCommand = Command.make("topics").pipe(
  Command.withDescription("Manage topics and per-channel contact subscriptions"),
  Command.withExamples([{ command: "samva topics list --json" }]),
  Command.withSubcommands([list, get, create, update, remove, setDefault, subscriptions]),
);
