import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Feedback from "samva/effect/feedback";

import { toCliApiError } from "../errors";
import { getClientProvider } from "../lib/client";
import { jsonFlag, printJson } from "../lib/output";

/** `samva feedback` — tell Samva's team what was confusing, broken, or missing in the API. */

type Category = NonNullable<Feedback.SendPayload["category"]>;
const CATEGORIES = [
  "bug",
  "confusing",
  "missing",
  "other",
] as const satisfies ReadonlyArray<Category>;

const send = Command.make("send", {
  message: Argument.String("message").pipe(
    Argument.withDescription("What happened and what you expected, in plain language"),
  ),
  category: Flag.Literals("category", CATEGORIES).pipe(
    Flag.withDescription("bug, confusing, missing, or other"),
    Flag.optional,
  ),
  operation: Flag.String("operation").pipe(
    Flag.withDescription("The command, SDK method, or `METHOD /path` the report is about"),
    Flag.optional,
  ),
  resourceId: Flag.String("resource-id").pipe(
    Flag.withDescription("The id of the resource involved, such as a message or domain id"),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Send feedback about the Samva API or this CLI to Samva's team. Returns a receipt; nobody replies here.",
  ),
  Command.withExamples([
    {
      command:
        'samva feedback send "The 422 did not say which field was wrong" --category confusing --operation "POST /v1/messages"',
    },
  ]),
  Command.withHandler(({ message, category, operation, resourceId, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const named = {
        operation: Option.getOrUndefined(operation),
        resourceId: Option.getOrUndefined(resourceId),
      };
      const receipt = yield* Feedback.send({
        message,
        category: Option.getOrUndefined(category),
        context:
          named.operation === undefined && named.resourceId === undefined ? undefined : named,
      }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not send feedback", error)),
      );
      if (json) return yield* printJson(receipt);
      yield* Console.log(`Sent feedback ${receipt.id}. Thank you.`);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

export const feedbackCommand = Command.make("feedback").pipe(
  Command.withDescription("Send feedback about the Samva API to Samva's team"),
  Command.withSubcommands([send]),
);
