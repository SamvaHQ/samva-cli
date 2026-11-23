import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Option from "effect/Option";
import * as Organizations from "samva/effect/organizations";

import { deriveOverride } from "../lib/derive/curated";
import { jsonFlag, printFields } from "../lib/output";

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

export const usageCommand = deriveOverride(
  "usage",
  {
    after: afterFlag,
    before: beforeFlag,
    json: jsonFlag,
  },
  {
    mapInput: ({ after, before }) => ({
      after: Option.getOrUndefined(after),
      before: Option.getOrUndefined(before),
    }),
    call: (request) => Organizations.getUsage(request),
    failure: "Could not get usage",
    render: (data) => {
      const { usage, billing } = data;
      return printFields([
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
    },
  },
).pipe(
  Command.withDescription("Get organization usage"),
  Command.withExamples([{ command: "samva org usage --after 2026-09-01T00:00:00Z --json" }]),
);
