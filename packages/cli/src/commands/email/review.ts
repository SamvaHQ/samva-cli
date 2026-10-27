import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as References from "effect/References";
import * as Email from "samva/effect/email";

import { toCliApiError } from "../../errors";
import { getClientProvider } from "../../lib/client";
import { jsonFlag, printFields, printJson } from "../../lib/output";

const readStatus = Effect.gen(function* () {
  const client = yield* getClientProvider;
  return yield* Email.getOnboardingReview().pipe(
    client.provide,
    Effect.mapError((error) => toCliApiError("Could not get email review status", error)),
  );
});

const status = Command.make("status", { json: jsonFlag }).pipe(
  Command.withDescription("Get organization and sending-identity review status"),
  Command.withExamples([{ command: "samva email review status --json" }]),
  Command.withHandler(({ json }) =>
    Effect.gen(function* () {
      const data = yield* readStatus;
      if (json) return yield* printJson(data);
      yield* printFields([
        ["Decision", data.decision],
        ["Stage", data.stage],
        ["Can send", data.canSend ? "yes" : "no"],
        ["Reason", data.code],
        ["Next action", data.nextAction],
        ["Generation", data.generation],
      ]);
      if (data.identities.length > 0) {
        yield* Console.log("\nSending identities:");
        for (const clearance of data.identities) {
          // The review decision alone is not permission — an approved identity whose material
          // facts have changed is blocked — so the line leads with what a send would do.
          yield* Console.log(
            `${clearance.identityId}  ${clearance.canSend ? "cleared" : "blocked"}  ${clearance.decision}${clearance.code ? `  ${clearance.code}` : ""}`,
          );
        }
      }
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const reapply = Command.make("reapply", { json: jsonFlag }).pipe(
  Command.withDescription("Resubmit a rejected organization for email review"),
  Command.withExamples([{ command: "samva email review reapply --json" }]),
  Command.withHandler(({ json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const current = yield* readStatus;
      const data = yield* Email.reapplyOnboardingReview({
        expectedGeneration: current.generation,
      }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not reapply for email review", error)),
      );
      if (json) return yield* printJson(data);
      yield* printFields([
        ["Decision", data.decision],
        ["Stage", data.stage],
        ["Reason", data.code],
        ["Next action", data.nextAction],
        ["Generation", data.generation],
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

export const reviewCommand = Command.make("review").pipe(
  Command.withDescription("Inspect or resubmit email onboarding review"),
  Command.withSubcommands([status, reapply]),
);
