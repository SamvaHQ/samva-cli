import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Email from "samva/effect/email";

import { CliUsageError, toCliApiError } from "../../errors";
import { getClientProvider } from "../../lib/client";
import { jsonFlag, printFields, printJson } from "../../lib/output";

const toggle = (name: string, description: string) =>
  Flag.Literals(name, ["on", "off"]).pipe(Flag.withDescription(description), Flag.optional);

const validateRecipientEmail = (email: string) =>
  Schema.decodeEffect(Email.TrackingRecipientEmail)(email).pipe(
    Effect.mapError(
      () =>
        new CliUsageError({
          code: "invalid_recipient_email",
          message: "Recipient must be a valid email address.",
        }),
    ),
  );

const defaultsGet = Command.make("get", { json: jsonFlag }).pipe(
  Command.withDescription("Get organization email tracking defaults"),
  Command.withExamples([{ command: "samva email tracking defaults get --json" }]),
  Command.withHandler(({ json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Email.getTrackingDefaults().pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not get email tracking defaults", error)),
      );
      if (json) return yield* printJson(data);
      yield* printFields([
        ["Track opens", data.opens ? "on" : "off"],
        ["Track clicks", data.clicks ? "on" : "off"],
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const defaultsSet = Command.make("set", {
  opens: toggle("opens", "Set the organization open-tracking default (on or off)"),
  clicks: toggle("clicks", "Set the organization click-tracking default (on or off)"),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Print the planned change without calling the API"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Update one or both organization email tracking defaults"),
  Command.withExamples([
    { command: "samva email tracking defaults set --opens off --dry-run" },
    { command: "samva email tracking defaults set --opens on --clicks off" },
  ]),
  Command.withHandler(({ opens, clicks, dryRun, json }) =>
    Effect.gen(function* () {
      const opensValue = Option.getOrUndefined(opens);
      const clicksValue = Option.getOrUndefined(clicks);
      if (opensValue === undefined && clicksValue === undefined) {
        return yield* new CliUsageError({
          code: "missing_tracking_default",
          message: "Provide --opens, --clicks, or both.",
        });
      }
      const request = {
        ...(opensValue === undefined ? {} : { opens: opensValue === "on" }),
        ...(clicksValue === undefined ? {} : { clicks: clicksValue === "on" }),
      };
      if (dryRun) {
        if (json)
          return yield* printJson({
            dryRun: true,
            action: "email.tracking.defaults.set",
            request,
          });
        return yield* Console.log(
          `[dry-run] Would update email tracking defaults: ${JSON.stringify(request)}.`,
        );
      }
      const client = yield* getClientProvider;
      const data = yield* Email.updateTrackingDefaults(request).pipe(
        client.provide,
        Effect.mapError((error) =>
          toCliApiError("Could not update email tracking defaults", error),
        ),
      );
      if (json) return yield* printJson(data);
      yield* printFields([
        ["Track opens", data.opens ? "on" : "off"],
        ["Track clicks", data.clicks ? "on" : "off"],
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const recipientGet = Command.make("get", {
  email: Argument.String("email").pipe(Argument.withDescription("Recipient email address")),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Get a recipient's email tracking preference"),
  Command.withExamples([
    { command: "samva email tracking recipient get person@example.com --json" },
  ]),
  Command.withHandler(({ email, json }) =>
    Effect.gen(function* () {
      const validatedEmail = yield* validateRecipientEmail(email);
      const client = yield* getClientProvider;
      const data = yield* Email.getRecipientTrackingPreference({ email: validatedEmail }).pipe(
        client.provide,
        Effect.mapError((error) =>
          toCliApiError("Could not get recipient tracking preference", error),
        ),
      );
      if (json) return yield* printJson(data);
      yield* printFields([
        ["Email", data.email],
        ["Tracking", data.optedOut ? "opted out" : "opted in"],
        ["Opted out at", data.trackingOptedOutAt ?? null],
        ["Updated at", data.updatedAt ?? null],
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const recipientSet = Command.make("set", {
  email: Argument.String("email").pipe(Argument.withDescription("Recipient email address")),
  state: Flag.Literals("state", ["opted-in", "opted-out"]).pipe(
    Flag.withDescription("Set the recipient tracking state (opted-in or opted-out)"),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Print the planned change without calling the API"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Opt a recipient in or out of email engagement tracking"),
  Command.withExamples([
    {
      command: "samva email tracking recipient set person@example.com --state opted-out --dry-run",
    },
    { command: "samva email tracking recipient set person@example.com --state opted-in" },
  ]),
  Command.withHandler(({ email, state, dryRun, json }) =>
    Effect.gen(function* () {
      const validatedEmail = yield* validateRecipientEmail(email);
      const request = { email: validatedEmail, optedOut: state === "opted-out" };
      if (dryRun) {
        if (json)
          return yield* printJson({
            dryRun: true,
            action: "email.tracking.recipient.set",
            request,
          });
        return yield* Console.log(
          `[dry-run] Would set ${email} to ${state} for email engagement tracking.`,
        );
      }
      const client = yield* getClientProvider;
      const data = yield* Email.updateRecipientTrackingPreference(request).pipe(
        client.provide,
        Effect.mapError((error) =>
          toCliApiError("Could not update recipient tracking preference", error),
        ),
      );
      if (json) return yield* printJson(data);
      yield* printFields([
        ["Email", data.email],
        ["Tracking", data.optedOut ? "opted out" : "opted in"],
        ["Opted out at", data.trackingOptedOutAt ?? null],
        ["Updated at", data.updatedAt ?? null],
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
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
