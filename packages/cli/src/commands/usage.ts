import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Organizations from "samva/effect/organizations";

import { toCliApiError } from "../errors";
import { getClientProvider } from "../lib/client";
import { jsonFlag, printFields, printJson } from "../lib/output";

const afterFlag = Flag.String("after").pipe(
  Flag.withDescription(
    "Start of the window, an ISO 8601 instant (default: the start of this calendar month)",
  ),
  Flag.optional,
);
const beforeFlag = Flag.String("before").pipe(
  Flag.withDescription("End of the window, an ISO 8601 instant (default: now)"),
  Flag.optional,
);

export const usageCommand = Command.make("usage", {
  after: afterFlag,
  before: beforeFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Get organization usage"),
  Command.withExamples([{ command: "samva org usage --after 2026-09-01T00:00:00Z --json" }]),
  Command.withHandler(({ after, before, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Organizations.getUsage({
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
      }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not get usage", error)),
      );
      if (json) return yield* printJson(data);
      const { usage, billing } = data;
      yield* printFields([
        ["Start", usage.periodStart],
        ["End", usage.periodEnd],
        ["Emails", usage.emailCount],
        ["Messages", usage.totalMessages],
        ["Plan", billing.planName],
        // Autumn reports these over its own billing cycle, not the window
        // above, and answers `null` for a workspace with no metered plan.
        [
          "Sending credits",
          billing.includedCredits === null
            ? "—"
            : `${billing.usedCredits} of ${billing.includedCredits}`,
        ],
        ["Extra sending credits", billing.overageCredits ?? "—"],
        [
          "Extra sending credit cost",
          billing.overageCost === null ? "—" : `${billing.overageCost} ${billing.currency}`,
        ],
        ["Sending credits reset", billing.creditsResetsAt ?? "—"],
        [
          "AI credits",
          billing.includedAiCredits === null
            ? "—"
            : `${billing.usedAiCredits} of ${billing.includedAiCredits}`,
        ],
        ["AI credits from packs", billing.aiPackCredits ?? "—"],
        ["Extra AI credits", billing.overageAiCredits ?? "—"],
        [
          "Extra AI credit cost",
          billing.overageAiCost === null ? "—" : `${billing.overageAiCost} ${billing.currency}`,
        ],
        ["AI credits reset", billing.aiResetsAt ?? "—"],
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
