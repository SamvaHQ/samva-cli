import { AbsoluteInstantFromString } from "@samva/core/shared/wire";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Analytics from "samva/effect/analytics";

import { toCliApiError } from "../errors";
import { getClientProvider } from "../lib/client";
import { namespaceField, namespaceFlag } from "../lib/namespace";
import { jsonFlag, objectRows, printFields, printJson } from "../lib/output";

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

const stats = Command.make("stats", {
  ...rangeFlags,
  groupBy: Flag.Literals("group-by", ["day", "week", "month"]).pipe(Flag.optional),
}).pipe(
  Command.withDescription("Read outbound message volume within the caller's scope"),
  Command.withExamples([{ command: "samva analytics stats --namespace ns_abc123 --json" }]),
  Command.withHandler(({ namespace, after, before, channel, groupBy, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Analytics.getStats({
        ...namespaceField(namespace),
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        channel: Option.getOrUndefined(channel),
        groupBy: Option.getOrUndefined(groupBy),
      }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not read analytics", error)),
      );
      if (json) return yield* printJson(data);
      yield* printFields(objectRows(data));
    }),
  ),
);

const deliveryMetrics = Command.make("delivery-metrics", rangeFlags).pipe(
  Command.withDescription("Read outbound delivery rates within the caller's scope"),
  Command.withExamples([
    { command: "samva analytics delivery-metrics --namespace ns_abc123 --channel email --json" },
  ]),
  Command.withHandler(({ namespace, after, before, channel, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Analytics.getDeliveryMetrics({
        ...namespaceField(namespace),
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
        channel: Option.getOrUndefined(channel),
      }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not read delivery metrics", error)),
      );
      if (json) return yield* printJson(data);
      yield* printFields(objectRows(data));
    }),
  ),
);

export const analyticsCommand = Command.make("analytics").pipe(
  Command.withDescription("Read messaging analytics; --namespace only narrows the caller's scope"),
  Command.withSubcommands([stats, deliveryMetrics]),
);
