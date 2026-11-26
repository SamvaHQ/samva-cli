import { onboardingReviewBlockMessage } from "@samva/core/shared/errors";
import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as References from "effect/References";
import * as Email from "samva/effect/email";

import { toCliApiError } from "../../errors";
import { getClientProvider } from "../../lib/client";
import { deriveOverride } from "../../lib/derive/curated";
import { jsonFlag, printFields, printJson } from "../../lib/output";

const readStatus = Effect.gen(function* () {
  const client = yield* getClientProvider;
  return yield* Email.getOnboardingReview().pipe(
    client.provide,
    Effect.mapError((error) => toCliApiError("Could not get email review status", error)),
  );
});

type ReviewStatus = Effect.Success<ReturnType<typeof Email.getOnboardingReview>>;

/** Which sending limits apply, in the words the dashboard and docs use. */
const limitsLabel = (tier: ReviewStatus["trustTier"]) =>
  tier === "established"
    ? "plan limits"
    : tier === "probation"
      ? "starting limits for new organizations"
      : "none until Samva's review approves the organization";

/** The human verdict line: whether email sends, and if not, why and what happens next. */
const reviewVerdict = (data: ReviewStatus) =>
  data.canSend
    ? "Email can send."
    : data.code === null || data.nextAction === null
      ? "Email cannot send yet."
      : onboardingReviewBlockMessage(data.code, data.nextAction);

const status = deriveOverride(
  "status",
  { json: jsonFlag },
  {
    call: () => Email.getOnboardingReview(),
    failure: "Could not get email review status",
    render: (data) =>
      Effect.gen(function* () {
        yield* Console.log(reviewVerdict(data));
        yield* printFields([
          ["Decision", data.decision],
          ["Stage", data.stage],
          ["Can send", data.canSend ? "yes" : "no"],
          ["Limits", limitsLabel(data.trustTier)],
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
      }),
  },
).pipe(
  Command.withDescription(
    "Show whether email can send, what Samva's review decided, and the next step",
  ),
  Command.withExamples([{ command: "samva email review status --json" }]),
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
  Command.withDescription("Check Samva's review of the organization's email sending, or reapply"),
  Command.withSubcommands([status, reapply]),
);
