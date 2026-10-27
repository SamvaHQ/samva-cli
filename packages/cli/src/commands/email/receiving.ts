import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Email from "samva/effect/email";

import { SamvaCliError, toCliApiError } from "../../errors";
import { getClientProvider } from "../../lib/client";
import { jsonFlag, printFields, printJson } from "../../lib/output";

const destinationLabel = (destination: {
  readonly endpointId: string | null;
  readonly forwardingRules: number;
  readonly mailboxes: number;
}): string => {
  const parts = [
    destination.endpointId === null ? [] : [`webhook ${destination.endpointId}`],
    destination.forwardingRules === 0
      ? []
      : [
          `${destination.forwardingRules} forwarding rule${destination.forwardingRules === 1 ? "" : "s"}`,
        ],
    destination.mailboxes === 0
      ? []
      : [`${destination.mailboxes} mailbox${destination.mailboxes === 1 ? "" : "es"}`],
  ].flat();
  return parts.length === 0
    ? "none (add a webhook endpoint or a forwarding rule)"
    : parts.join(", ");
};

const mxLabel = (mx: {
  readonly state: string;
  readonly expected: { readonly exchange: string };
  readonly current: ReadonlyArray<{ readonly exchange: string }>;
}): string => {
  switch (mx.state) {
    case "pointing-here":
      return `points at ${mx.expected.exchange}`;
    case "elsewhere":
      return `routes mail to ${mx.current[0]?.exchange ?? "another provider"}; set it to ${mx.expected.exchange}`;
    case "missing":
      return `no MX record; add ${mx.expected.exchange}`;
    default:
      return "could not be looked up; try again";
  }
};

const status = Command.make("status", {
  domainId: Argument.String("domain-id").pipe(Argument.withDescription("Sending domain id")),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Report each prerequisite for receiving a domain's mail at Samva, in order, with a live MX lookup",
  ),
  Command.withExamples([{ command: "samva email receiving status dom_abc123 --json" }]),
  Command.withHandler(({ domainId, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Email.getReceivingStatus({ id: domainId }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not get receiving status", error)),
      );
      if (json) return yield* printJson(data);
      const mark = (satisfied: boolean) => (satisfied ? "done" : "todo");
      yield* printFields([
        ["Domain", data.domain],
        ["1. Sending", `${mark(data.sending.satisfied)} (${data.sending.phase})`],
        [
          "2. Destination",
          `${mark(data.destination.satisfied)} ${destinationLabel(data.destination)}`,
        ],
        [
          "3. Receiving",
          `${mark(data.receiving.satisfied)}${data.receiving.catchAll ? " (catch-all)" : ""}`,
        ],
        [`4. Inbound MX`, `${mark(data.mx.satisfied)} ${data.receivingHost} ${mxLabel(data.mx)}`],
        ["Ready", data.ready ? "yes" : "no"],
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const enable = Command.make("enable", {
  domainId: Argument.String("domain-id").pipe(Argument.withDescription("Sending domain id")),
  domain: Flag.String("domain").pipe(Flag.withDescription("Verified domain name")),
  address: Flag.String("address").pipe(
    Flag.withDescription("Exact recipient address to receive (repeatable)"),
    Flag.atLeast(0),
  ),
  catchAll: Flag.Boolean("catch-all").pipe(
    Flag.withDescription(
      "Receive every address on the domain. Needs --endpoint or an active forwarding rule that covers the domain",
    ),
    Flag.withDefault(false),
  ),
  endpoint: Flag.String("endpoint").pipe(
    Flag.withDescription(
      "Webhook endpoint id that receives message.received for a catch-all domain",
    ),
    Flag.optional,
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Print the provider setup request without calling the API"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Enable inbound receiving for a verified domain. Receiving needs somewhere to deliver: exact addresses are accepted, and a catch-all needs a webhook endpoint or a forwarding rule",
  ),
  Command.withExamples([
    {
      command:
        "samva email receiving enable dom_abc123 --domain example.com --catch-all --endpoint wep_abc123",
    },
    {
      command: "samva email receiving enable dom_abc123 --domain example.com --catch-all",
    },
    {
      command:
        "samva email receiving enable dom_abc123 --domain example.com --address replies@example.com --dry-run",
    },
    {
      command:
        "samva email receiving enable dom_abc123 --domain example.com --address replies@example.com",
    },
  ]),
  Command.withHandler(({ domainId, domain, address, catchAll, endpoint, dryRun, json }) =>
    Effect.gen(function* () {
      if (address.length === 0 && !catchAll) {
        return yield* new SamvaCliError({
          message: "Pass --address for each exact recipient, or --catch-all for the whole domain.",
        });
      }
      const endpointId = Option.getOrUndefined(endpoint);
      if (endpointId !== undefined && !catchAll) {
        return yield* new SamvaCliError({
          message: "--endpoint names the catch-all webhook, so it needs --catch-all.",
        });
      }
      const request = {
        domain,
        catchAll,
        addresses: [...address],
        ...(endpointId === undefined ? {} : { endpointId }),
      };
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "email.receiving.enable", domainId, request })
          : Console.log(
              `[dry-run] Would enable receiving for ${domain} (${catchAll ? "catch-all" : address.join(", ")}).`,
            );
      const client = yield* getClientProvider;
      const data = yield* Email.enableReceiving({ id: domainId, ...request }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not enable receiving", error)),
      );
      if (json) return yield* printJson(data);
      yield* printFields([["Recipients", data.recipients.join(", ")]]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

export const receivingCommand = Command.make("receiving").pipe(
  Command.withDescription("Move a domain's inbound email to Samva and check what is left to do"),
  Command.withExamples([{ command: "samva email receiving status dom_abc123" }]),
  Command.withSubcommands([status, enable]),
);
