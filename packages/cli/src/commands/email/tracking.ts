import { EmailAddressString } from "@samva/core/shared/base";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Email from "samva/effect/email";

import { CliUsageError } from "../../errors";
import { deriveOverride } from "../../lib/derive/curated";
import { jsonFlag, printFields } from "../../lib/output";

const toggle = (name: string, description: string) =>
  Flag.Literals(name, ["on", "off"]).pipe(Flag.withDescription(description), Flag.optional);

const validateRecipientEmail = (email: string) =>
  Schema.decodeEffect(EmailAddressString)(email).pipe(
    Effect.mapError(
      () =>
        new CliUsageError({
          code: "invalid_recipient_email",
          message: "Recipient must be a valid email address.",
        }),
    ),
  );

const defaultsGet = deriveOverride(
  "get",
  { json: jsonFlag },
  {
    call: () => Email.getTrackingDefaults(),
    failure: "Could not get email tracking defaults",
    render: (data) =>
      printFields([
        ["Track opens", data.opens ? "on" : "off"],
        ["Track clicks", data.clicks ? "on" : "off"],
      ]),
  },
).pipe(
  Command.withDescription("Get organization email tracking defaults"),
  Command.withExamples([{ command: "samva email tracking defaults get --json" }]),
);

const defaultsSet = deriveOverride(
  "set",
  {
    opens: toggle("opens", "Set the organization open-tracking default (on or off)"),
    clicks: toggle("clicks", "Set the organization click-tracking default (on or off)"),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Print the planned change without calling the API"),
      Flag.withDefault(false),
    ),
    json: jsonFlag,
  },
  {
    prepare: ({ opens, clicks }) =>
      Effect.gen(function* () {
        const opensValue = Option.getOrUndefined(opens);
        const clicksValue = Option.getOrUndefined(clicks);
        if (opensValue === undefined && clicksValue === undefined) {
          return yield* new CliUsageError({
            code: "missing_tracking_default",
            message: "Provide --opens, --clicks, or both.",
          });
        }
        return {
          ...(opensValue === undefined ? {} : { opens: opensValue === "on" }),
          ...(clicksValue === undefined ? {} : { clicks: clicksValue === "on" }),
        };
      }),
    call: (request) => Email.updateTrackingDefaults(request),
    failure: "Could not update email tracking defaults",
    preview: {
      data: (request) => ({ dryRun: true, action: "email.tracking.defaults.set", request }),
      render: (request) =>
        Console.log(`[dry-run] Would update email tracking defaults: ${JSON.stringify(request)}.`),
    },
    render: (data) =>
      printFields([
        ["Track opens", data.opens ? "on" : "off"],
        ["Track clicks", data.clicks ? "on" : "off"],
      ]),
  },
).pipe(
  Command.withDescription("Update one or both organization email tracking defaults"),
  Command.withExamples([
    { command: "samva email tracking defaults set --opens off --dry-run" },
    { command: "samva email tracking defaults set --opens on --clicks off" },
  ]),
);

const recipientGet = deriveOverride(
  "get",
  {
    email: Argument.String("email").pipe(Argument.withDescription("Recipient email address")),
    json: jsonFlag,
  },
  {
    prepare: ({ email }) =>
      validateRecipientEmail(email).pipe(
        Effect.map((validatedEmail) => ({ email: validatedEmail })),
      ),
    call: (request) => Email.getRecipientTrackingPreference(request),
    failure: "Could not get recipient tracking preference",
    render: (data) =>
      printFields([
        ["Email", data.email],
        ["Tracking", data.optedOut ? "opted out" : "opted in"],
        ["Opted out at", data.trackingOptedOutAt ?? null],
        ["Updated at", data.updatedAt ?? null],
      ]),
  },
).pipe(
  Command.withDescription("Get a recipient's email tracking preference"),
  Command.withExamples([
    { command: "samva email tracking recipient get person@example.com --json" },
  ]),
);

const recipientSet = deriveOverride(
  "set",
  {
    email: Argument.String("email").pipe(Argument.withDescription("Recipient email address")),
    state: Flag.Literals("state", ["opted-in", "opted-out"]).pipe(
      Flag.withDescription("Set the recipient tracking state (opted-in or opted-out)"),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Print the planned change without calling the API"),
      Flag.withDefault(false),
    ),
    json: jsonFlag,
  },
  {
    prepare: ({ email, state }) =>
      validateRecipientEmail(email).pipe(
        Effect.map((validatedEmail) => ({
          email: validatedEmail,
          optedOut: state === "opted-out",
        })),
      ),
    call: (request) => Email.updateRecipientTrackingPreference(request),
    failure: "Could not update recipient tracking preference",
    preview: {
      data: (request) => ({ dryRun: true, action: "email.tracking.recipient.set", request }),
      render: (_request, input) =>
        Console.log(
          `[dry-run] Would set ${input.email} to ${input.state} for email engagement tracking.`,
        ),
    },
    render: (data) =>
      printFields([
        ["Email", data.email],
        ["Tracking", data.optedOut ? "opted out" : "opted in"],
        ["Opted out at", data.trackingOptedOutAt ?? null],
        ["Updated at", data.updatedAt ?? null],
      ]),
  },
).pipe(
  Command.withDescription("Opt a recipient in or out of email engagement tracking"),
  Command.withExamples([
    {
      command: "samva email tracking recipient set person@example.com --state opted-out --dry-run",
    },
    { command: "samva email tracking recipient set person@example.com --state opted-in" },
  ]),
);

const defaults = Command.make("defaults").pipe(
  Command.withDescription("Read or update organization tracking defaults"),
  Command.withSubcommands([defaultsGet, defaultsSet]),
);

const recipient = Command.make("recipient").pipe(
  Command.withDescription("Read or update a recipient tracking preference"),
  Command.withSubcommands([recipientGet, recipientSet]),
);

export const trackingCommand = Command.make("tracking").pipe(
  Command.withDescription("Configure email engagement tracking"),
  Command.withExamples([{ command: "samva email tracking defaults get" }]),
  Command.withSubcommands([defaults, recipient]),
);
