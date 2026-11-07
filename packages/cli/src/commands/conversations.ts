import { ConversationId } from "@samva/core/shared/base";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Conversations from "samva/effect/conversations";

import { toCliApiError } from "../errors";
import { getClientProvider } from "../lib/client";
import { namespaceField, namespaceFlag } from "../lib/namespace";
import { jsonFlag, objectRows, printFields, printJson } from "../lib/output";

const list = Command.make("list", {
  namespace: namespaceFlag("list"),
  limit: Flag.Int("limit").pipe(Flag.withDescription("Items per page"), Flag.optional),
  cursor: Flag.String("cursor").pipe(
    Flag.withDescription("Resume after nextCursor"),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List reachable conversations, most recently active first"),
  Command.withExamples([{ command: "samva conversations list --namespace ns_abc123 --json" }]),
  Command.withHandler(({ namespace, limit, cursor, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const page = yield* Conversations.list({
        ...namespaceField(namespace),
        limit: Option.getOrUndefined(limit),
        cursor: Option.getOrUndefined(cursor),
      }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not list conversations", error)),
      );
      if (json) return yield* printJson(page);
      if (page.items.length === 0) yield* Console.log("No conversations.");
      for (const item of page.items) yield* printFields(objectRows(item));
      if (page.nextCursor !== null) yield* printFields([["Next cursor", page.nextCursor]]);
    }),
  ),
);

const get = Command.make("get", {
  id: Argument.String("id").pipe(Argument.withSchema(ConversationId)),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Read a conversation and its contacts within the caller's scope"),
  Command.withExamples([{ command: "samva conversations get conv_abc123 --json" }]),
  Command.withHandler(({ id, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Conversations.getById({ id }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not read conversation", error)),
      );
      if (json) return yield* printJson(data);
      yield* printFields(objectRows(data));
    }),
  ),
);

const create = Command.make("create", {
  namespace: namespaceFlag("create"),
  title: Flag.String("title").pipe(Flag.optional),
  channel: Flag.Literals("channel", ["email", "whatsapp", "sms"]).pipe(
    Flag.withDescription("The conversation's initial and primary channel"),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create a conversation in a namespace or at organization level"),
  Command.withExamples([
    {
      command:
        'samva conversations create --channel email --title "Billing question" --namespace ns_abc123 --dry-run',
    },
  ]),
  Command.withHandler(({ namespace, title, channel, dryRun, json }) =>
    Effect.gen(function* () {
      const payload = {
        ...namespaceField(namespace),
        title: Option.getOrUndefined(title),
        channels: [channel],
        primaryChannel: channel,
      };
      if (dryRun) {
        return yield* json
          ? printJson({ dryRun: true, request: payload })
          : printFields(objectRows(payload, { explicit: true }));
      }
      const client = yield* getClientProvider;
      const data = yield* Conversations.create(payload).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not create conversation", error)),
      );
      if (json) return yield* printJson(data);
      yield* printFields(objectRows(data));
    }),
  ),
);

export const conversationsCommand = Command.make("conversations").pipe(
  Command.withDescription("Read and create conversations within the caller's scope"),
  Command.withSubcommands([list, get, create]),
);
