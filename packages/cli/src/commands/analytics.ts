import { AbsoluteInstantFromString } from "@samva/core/shared/wire";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Option from "effect/Option";

import { withContractRead } from "../lib/derive/curated";
import { namespaceField, namespaceFlag } from "../lib/namespace";
import { jsonFlag } from "../lib/output";

const rangeFlags = {
  namespace: namespaceFlag("list"),
  after: Flag.String("after").pipe(
    Flag.withSchema(AbsoluteInstantFromString),
    Flag.withDescription("Start of the range, inclusive, as an ISO 8601 instant"),
    Flag.optional,
  ),
  before: Flag.String("before").pipe(
    Flag.withSchema(AbsoluteInstantFromString),
    Flag.withDescription("End of the range, exclusive, as an ISO 8601 instant"),
    Flag.optional,
  ),
  channel: Flag.Literals("channel", ["email", "whatsapp", "sms"]).pipe(Flag.optional),
  json: jsonFlag,
};

const statsFlags = {
  ...rangeFlags,
  groupBy: Flag.Literals("group-by", ["day", "week", "month"]).pipe(Flag.optional),
};

type RangeInput = Command.Command.Config.Infer<typeof rangeFlags>;
type StatsInput = Command.Command.Config.Infer<typeof statsFlags>;

const rangeQuery = ({ namespace, after, before, channel }: RangeInput) => ({
  ...namespaceField(namespace),
  after: Option.getOrUndefined(after),
  before: Option.getOrUndefined(before),
  channel: Option.getOrUndefined(channel),
});

const stats = Command.make("stats", statsFlags).pipe(
  Command.withDescription("Read outbound message volume within the caller's scope"),
  Command.withExamples([{ command: "samva analytics stats --namespace ns_abc123 --json" }]),
  withContractRead("analytics.getStats", "Could not read analytics", (input: StatsInput) => ({
    query: { ...rangeQuery(input), groupBy: Option.getOrUndefined(input.groupBy) },
  })),
);

const deliveryMetrics = Command.make("delivery-metrics", rangeFlags).pipe(
  Command.withDescription("Read outbound delivery rates within the caller's scope"),
  Command.withExamples([
    { command: "samva analytics delivery-metrics --namespace ns_abc123 --channel email --json" },
  ]),
  withContractRead(
    "analytics.getDeliveryMetrics",
    "Could not read delivery metrics",
    (input: RangeInput) => ({
      query: rangeQuery(input),
    }),
  ),
);

export const analyticsCommand = Command.make("analytics").pipe(
  Command.withDescription("Read messaging analytics; --namespace only narrows the caller's scope"),
  Command.withSubcommands([stats, deliveryMetrics]),
);
