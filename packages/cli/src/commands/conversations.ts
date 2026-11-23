import { ConversationId } from "@samva/core/shared/base";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Conversations from "samva/effect/conversations";

import { deriveOverride } from "../lib/derive/curated";
import { namespaceField, namespaceFlag } from "../lib/namespace";
import { jsonFlag, objectRows, printFields } from "../lib/output";

const list = deriveOverride(
  "list",
  {
    namespace: namespaceFlag("list"),
    limit: Flag.Int("limit").pipe(Flag.withDescription("Items per page"), Flag.optional),
    cursor: Flag.String("cursor").pipe(
      Flag.withDescription("Resume after nextCursor"),
      Flag.optional,
    ),
    json: jsonFlag,
  },
  {
    mapInput: ({ namespace, limit, cursor }) => ({
      ...namespaceField(namespace),
      limit: Option.getOrUndefined(limit),
      cursor: Option.getOrUndefined(cursor),
    }),
    call: (request) => Conversations.list(request),
    failure: "Could not list conversations",
    render: (page) =>
      Effect.gen(function* () {
        if (page.items.length === 0) yield* Console.log("No conversations.");
        for (const item of page.items) yield* printFields(objectRows(item));
        if (page.nextCursor !== null) yield* printFields([["Next cursor", page.nextCursor]]);
      }),
  },
).pipe(
  Command.withDescription("List reachable conversations, most recently active first"),
  Command.withExamples([{ command: "samva conversations list --namespace ns_abc123 --json" }]),
);

const getFlags = {
  id: Argument.String("id").pipe(Argument.withSchema(ConversationId)),
  json: jsonFlag,
};

const get = deriveOverride("get", getFlags, {
  mapInput: ({ id }) => ({ id }),
  call: (request) => Conversations.getById(request),
  failure: "Could not read conversation",
  render: (data) => printFields(objectRows(data)),
}).pipe(
  Command.withDescription("Read a conversation and its contacts within the caller's scope"),
  Command.withExamples([{ command: "samva conversations get conv_abc123 --json" }]),
);

const create = deriveOverride(
  "create",
  {
    namespace: namespaceFlag("create"),
    title: Flag.String("title").pipe(Flag.optional),
    channel: Flag.Literals("channel", ["email", "whatsapp", "sms"]).pipe(
      Flag.withDescription("The conversation's initial and primary channel"),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    json: jsonFlag,
  },
  {
    mapInput: ({ namespace, title, channel }) => ({
      ...namespaceField(namespace),
      title: Option.getOrUndefined(title),
      channels: [channel],
      primaryChannel: channel,
    }),
    call: (request) => Conversations.create(request),
    failure: "Could not create conversation",
    preview: {
      data: (request) => ({ dryRun: true, request }),
      render: (request) => printFields(objectRows(request, { explicit: true })),
    },
    render: (data) => printFields(objectRows(data)),
  },
).pipe(
  Command.withDescription("Create a conversation in a namespace or at organization level"),
  Command.withExamples([
    {
      command:
        'samva conversations create --channel email --title "Billing question" --namespace ns_abc123 --dry-run',
    },
  ]),
);

export const conversationsCommand = Command.make("conversations").pipe(
  Command.withDescription("Read and create conversations within the caller's scope"),
  Command.withSubcommands([list, get, create]),
);
