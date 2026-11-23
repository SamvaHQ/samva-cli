import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Option from "effect/Option";
import * as Subscriptions from "samva/effect/subscriptions";

import { deriveOverride } from "../lib/derive/curated";
import { jsonFlag } from "../lib/output";

const subscribe = deriveOverride(
  "subscribe",
  {
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
  },
  {
    mapInput: (input) => ({
      email: input.email,
      topicId: input.topicId,
      from: { email: input.from, name: Option.getOrUndefined(input.fromName) },
      templateSlug: Option.getOrUndefined(input.templateSlug),
      consentIp: Option.getOrUndefined(input.consentIp),
      consentSource: Option.getOrUndefined(input.consentSource),
    }),
    call: (request) => Subscriptions.subscribe(request),
    failure: "Could not request subscription confirmation",
    render: (receipt) =>
      Console.log(
        `Confirmation request accepted: ${receipt.success}. Expires at ${receipt.expiresAt}. Subscription awaits recipient confirmation.`,
      ),
  },
).pipe(
  Command.withDescription(
    "Request one confirmation email; the recipient must confirm before joining",
  ),
  Command.withExamples([
    {
      command:
        "samva subscriptions subscribe --email ada@example.com --topic-id tpc_1234567890abcdef --from newsletter@example.com --json",
    },
  ]),
);

export const subscriptionsCommand = Command.make("subscriptions").pipe(
  Command.withDescription("Request recipient-confirmed email subscriptions"),
  Command.withSubcommands([subscribe]),
);
