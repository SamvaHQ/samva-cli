import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Subscriptions from "samva/effect/subscriptions";

import { toCliApiError } from "../errors";
import { getClientProvider } from "../lib/client";
import { jsonFlag, printJson } from "../lib/output";

const subscribe = Command.make("subscribe", {
  email: Flag.String("email").pipe(Flag.withDescription("Recipient email address")),
  topicId: Flag.String("topic-id").pipe(
    Flag.withDescription("Topic the recipient subscribes to after confirmation"),
  ),
  from: Flag.String("from").pipe(Flag.withDescription("Sender on your verified sending domain")),
  fromName: Flag.String("from-name").pipe(
    Flag.withDescription("Sender display name"),
    Flag.optional,
  ),
  templateSlug: Flag.String("template-slug").pipe(
    Flag.withDescription("Published confirmation template accepting confirmUrl input"),
    Flag.optional,
  ),
  consentIp: Flag.String("consent-ip").pipe(
    Flag.withDescription("Signup IP derived by your server from a trusted request"),
    Flag.optional,
  ),
  consentSource: Flag.String("consent-source").pipe(
    Flag.withDescription("Where the recipient requested the subscription"),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Request one confirmation email; the recipient must confirm before joining",
  ),
  Command.withExamples([
    {
      command:
        "samva subscriptions subscribe --email ada@example.com --topic-id unsub_1234567890abcdef --from newsletter@example.com --json",
    },
  ]),
  Command.withHandler(
    ({ email, topicId, from, fromName, templateSlug, consentIp, consentSource, json }) =>
      Effect.gen(function* () {
        const client = yield* getClientProvider;
        const receipt = yield* Subscriptions.subscribe({
          email,
          topicId,
          from: { email: from, name: Option.getOrUndefined(fromName) },
          templateSlug: Option.getOrUndefined(templateSlug),
          consentIp: Option.getOrUndefined(consentIp),
          consentSource: Option.getOrUndefined(consentSource),
        }).pipe(
          client.provide,
          Effect.mapError((error) =>
            toCliApiError("Could not request subscription confirmation", error),
          ),
        );
        if (json) return yield* printJson(receipt);
        yield* Console.log(
          `Confirmation request accepted: ${receipt.success}. Expires at ${receipt.expiresAt}. Subscription awaits recipient confirmation.`,
        );
      }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

export const subscriptionsCommand = Command.make("subscriptions").pipe(
  Command.withDescription("Request recipient-confirmed email subscriptions"),
  Command.withSubcommands([subscribe]),
);
