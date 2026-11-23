import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Topics from "samva/effect/topics";

import { CliUsageError } from "../errors";
import { deriveOverride } from "../lib/derive/curated";
import { jsonFlag, printFields } from "../lib/output";

const idArgument = Argument.String("id").pipe(Argument.withDescription("Topic id (tpc_...)"));
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

const list = deriveOverride(
  "list",
  {
    namespaceId: optionalString("namespace", "Limit to one namespace"),
    json: jsonFlag,
  },
  {
    mapInput: (input) => ({ namespaceId: Option.getOrUndefined(input.namespaceId) }),
    call: (request) => Topics.list(request),
    failure: "Could not list topics",
    render: (data) =>
      Effect.gen(function* () {
        if (data.items.length === 0) return yield* Console.log("No topics found.");
        for (const topic of data.items) yield* topicFields(topic);
      }),
  },
).pipe(
  Command.withDescription("List topics, default first (bounded by the organization's topic limit)"),
  Command.withExamples([{ command: "samva topics list --json" }]),
);

const get = deriveOverride(
  "get",
  { id: idArgument, json: jsonFlag },
  {
    mapInput: (input) => ({ id: input.id }),
    call: (request) => Topics.get(request),
    failure: "Could not get topic",
    render: (data) => topicFields(data),
  },
).pipe(
  Command.withDescription("Read a topic and its publishing defaults"),
  Command.withExamples([{ command: "samva topics get tpc_1234567890abcdef --json" }]),
);

const create = deriveOverride(
  "create",
  {
    name: Flag.String("name").pipe(Flag.withDescription("Topic name")),
    namespaceId: optionalString("namespace", "Namespace for the topic and its contacts"),
    default: defaultFlag,
    ...publishingFlags,
    dryRun: dryRunFlag,
    json: jsonFlag,
  },
  {
    mapInput: (input) => ({
      name: input.name,
      namespaceId: Option.getOrUndefined(input.namespaceId),
      default: Option.getOrUndefined(input.default),
      description: nullableValue(input.description),
      defaultSenderId: nullableValue(input.defaultSenderId),
      replyMailboxId: nullableValue(input.replyMailboxId),
      templateId: nullableValue(input.templateId),
    }),
    call: (request) => Topics.create(request),
    failure: "Could not create topic",
    preview: {
      data: (request) => ({ dryRun: true, action: "topics.create", request }),
      render: (request) => Console.log(JSON.stringify(request)),
    },
    render: (data) => topicFields(data),
  },
).pipe(
  Command.withDescription("Create a topic with per-channel subscription preferences"),
  Command.withExamples([
    { command: "samva topics create --name Newsletter --default opt_in --json" },
  ]),
);

const update = deriveOverride(
  "update",
  {
    id: idArgument,
    name: optionalString("name", "New topic name"),
    default: defaultFlag,
    ...publishingFlags,
    dryRun: dryRunFlag,
    json: jsonFlag,
  },
  {
    prepare: (input) =>
      Effect.gen(function* () {
        if (
          [
            input.name,
            input.default,
            input.description,
            input.defaultSenderId,
            input.replyMailboxId,
            input.templateId,
          ].every(Option.isNone)
        )
          return yield* new CliUsageError({
            code: "nothing_to_update",
            message: "Pass a field to change. Run `samva topics update --help`.",
          });
        return {
          id: input.id,
          name: Option.getOrUndefined(input.name),
          default: Option.getOrUndefined(input.default),
          description: nullableValue(input.description),
          defaultSenderId: nullableValue(input.defaultSenderId),
          replyMailboxId: nullableValue(input.replyMailboxId),
          templateId: nullableValue(input.templateId),
        };
      }),
    call: (request) => Topics.update(request),
    failure: "Could not update topic",
    preview: {
      data: (request) => ({ dryRun: true, action: "topics.update", request }),
      render: (request) => Console.log(JSON.stringify(request)),
    },
    render: (data) => topicFields(data),
  },
).pipe(
  Command.withDescription("Update a topic; changing its default preserves explicit subscriptions"),
  Command.withExamples([
    { command: "samva topics update tpc_1234567890abcdef --name Updates --default opt_out" },
  ]),
);

const remove = deriveOverride(
  "remove",
  {
    id: idArgument,
    dryRun: dryRunFlag,
    yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
    json: jsonFlag,
  },
  {
    mapInput: (input) => ({ id: input.id }),
    call: (request) => Topics.remove(request),
    failure: "Could not remove topic",
    preview: {
      data: (request) => ({ dryRun: true, action: "topics.remove", id: request.id }),
      render: (request) => Console.log(`[dry-run] Would remove topic ${request.id}.`),
    },
    confirmation: (request) => ({
      message: `Remove topic ${request.id} and its subscriptions?`,
      nonInteractiveMessage:
        "Topic removal requires --yes outside a terminal. Preview with --dry-run.",
    }),
    render: (_data, _input, request) => Console.log(`Removed topic ${request.id}.`),
  },
).pipe(
  Command.withDescription(
    "Delete a topic; default topics and topics used by active campaigns are refused",
  ),
  Command.withExamples([{ command: "samva topics remove tpc_1234567890abcdef --dry-run --json" }]),
);

const setDefault = deriveOverride(
  "default",
  {
    id: idArgument,
    dryRun: dryRunFlag,
    json: jsonFlag,
  },
  {
    mapInput: (input) => ({ id: input.id }),
    call: (request) => Topics.setDefault(request),
    failure: "Could not set default topic",
    preview: {
      data: (request) => ({ dryRun: true, action: "topics.setDefault", id: request.id }),
      render: (request) => Console.log(`[dry-run] Would set default topic ${request.id}.`),
    },
    render: (data) => topicFields(data),
  },
).pipe(
  Command.withDescription("Select the organization's default topic"),
  Command.withExamples([{ command: "samva topics default tpc_1234567890abcdef --json" }]),
);

const listSubscriptions = deriveOverride(
  "list",
  {
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
  },
  {
    mapInput: (input) => ({
      id: input.id,
      channel: Option.getOrUndefined(input.channel),
      status: Option.getOrUndefined(input.status),
      limit: Option.getOrUndefined(input.limit),
      cursor: Option.getOrUndefined(input.cursor),
    }),
    call: (request) => Topics.listSubscriptions(request),
    failure: "Could not list topic subscriptions",
    paginate: {
      start: (request) => request.cursor,
      withCursor: (request, cursor) => ({ ...request, cursor }),
    },
    render: (data) =>
      Effect.gen(function* () {
        if (data.items.length === 0) {
          yield* Console.log("No explicit subscriptions found.");
        }
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
      }),
  },
).pipe(
  Command.withDescription("List explicit topic subscriptions; absent rows use the topic default"),
  Command.withExamples([
    { command: "samva topics subscriptions list tpc_1234567890abcdef --channel email --json" },
  ]),
);

const setSubscriptions = deriveOverride(
  "set",
  {
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
  },
  {
    prepare: (input) =>
      Effect.gen(function* () {
        const contacts = [
          ...input.contactIds.map((contactId) => ({ contactId })),
          ...input.emails.map((email) => ({ email })),
          ...input.phones.map((phone) => ({ phone })),
        ];
        if (contacts.length === 0 || contacts.length > 1000)
          return yield* new CliUsageError({
            code: "invalid_contact_count",
            message: "Pass 1–1000 contacts using repeatable --contact-id, --email, or --phone.",
          });
        return {
          id: input.id,
          contacts,
          channel: input.channel,
          status: input.status,
          source: Option.getOrUndefined(input.source),
        };
      }),
    call: (request) => Topics.setSubscriptions(request),
    failure: "Could not set topic subscriptions",
    preview: {
      data: (request) => ({ dryRun: true, action: "topics.setSubscriptions", request }),
      render: (request) =>
        Console.log(
          `[dry-run] Would set ${request.contacts.length} ${request.channel} subscriptions to ${request.status} for ${request.id}.`,
        ),
    },
    render: (data) =>
      printFields([
        ["Updated", data.updated],
        ["Kept unsubscribed", data.kept],
      ]),
  },
).pipe(
  Command.withDescription(
    "Set explicit subscribed or unsubscribed status for one channel; subscribing keeps email unsubscribes",
  ),
  Command.withExamples([
    {
      command:
        "samva topics subscriptions set tpc_1234567890abcdef --email ada@example.com --channel email --status subscribed --source import --json",
    },
  ]),
);

const check = deriveOverride(
  "check",
  {
    contactId: optionalString("contact-id", "Contact id; choose exactly one identifier"),
    email: optionalString("email", "Email address"),
    phone: optionalString("phone", "Phone address"),
    namespaceId: optionalString("namespace", "Namespace in which to resolve the address"),
    channel: channelFlag,
    topicIds: Flag.String("topic-id").pipe(
      Flag.withDescription("Topic to check (repeatable); omit for all visible topics"),
      Flag.atLeast(0),
    ),
    json: jsonFlag,
  },
  {
    prepare: (input) =>
      Effect.gen(function* () {
        if ([input.contactId, input.email, input.phone].filter(Option.isSome).length !== 1)
          return yield* new CliUsageError({
            code: "contact_identifier_required",
            message: "Pass exactly one of --contact-id, --email, or --phone.",
          });
        return {
          contactId: Option.getOrUndefined(input.contactId),
          email: Option.getOrUndefined(input.email),
          phone: Option.getOrUndefined(input.phone),
          namespaceId: Option.getOrUndefined(input.namespaceId),
          channel: input.channel,
          topicIds: input.topicIds.length === 0 ? undefined : input.topicIds.join(","),
        };
      }),
    call: (request) => Topics.checkSubscription(request),
    failure: "Could not check topic subscriptions",
    render: (data) =>
      Effect.gen(function* () {
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
      }),
  },
).pipe(
  Command.withDescription("Check effective subscription status, including topic defaults"),
  Command.withExamples([
    { command: "samva topics subscriptions check --email ada@example.com --channel email --json" },
  ]),
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
