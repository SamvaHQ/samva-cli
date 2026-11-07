import { PolicyScopeParams } from "@samva/contracts/policies/group";
import * as Policy from "@samva/core/policy/model";
import { Console, Effect, Option, Schema } from "effect";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Policies from "samva/effect/policies";

import { toCliApiError } from "../errors";
import { getClientProvider } from "../lib/client";
import { jsonFlag, printFields, printJson } from "../lib/output";

const scope = {
  kind: Argument.Literals("kind", PolicyScopeParams.kind.literals).pipe(
    Argument.withDescription("Policy scope: organization, mailbox, apiKey, or agent"),
  ),
  id: Argument.String("id").pipe(Argument.withDescription("The scope's resource id")),
};
const ifVersionFlag = Flag.Int("if-version").pipe(
  Flag.withSchema(Policy.Version),
  Flag.withDescription("Match this observed version; omit to read the current version first"),
  Flag.optional,
);
const printPolicy = (
  policy: Policy.Snapshot | Effect.Success<ReturnType<typeof Policies.getPolicy>>,
) =>
  Effect.gen(function* () {
    yield* printFields([
      ["Version", policy.version],
      ["Presets", policy.presets.length ? policy.presets.join(", ") : "none"],
      ["Instructions", policy.instructions],
    ]);
    yield* Console.log("Rules:");
    if (!policy.rules.length) yield* Console.log("  none");
    for (const rule of policy.rules)
      yield* Console.log(
        `  ${JSON.stringify(rule.match)}: ${rule.decide === undefined ? `at least ${rule.atLeast}` : rule.decide}${rule.note === undefined ? "" : `; ${rule.note}`}`,
      );
  });
const get = Command.make("get", { ...scope, json: jsonFlag }).pipe(
  Command.withDescription("Read the decision policy and its version for one scope"),
  Command.withExamples([{ command: "samva policies get mailbox mbx_1234567890123456 --json" }]),
  Command.withHandler(({ kind, id, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const policy = yield* Policies.getPolicy({ kind, id }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not read policy", error)),
      );
      yield* json ? printJson(policy) : printPolicy(policy);
    }),
  ),
);
const set = Command.make("set", {
  ...scope,
  data: Flag.String("data").pipe(
    Flag.withSchema(Schema.fromJsonString(Policy.Configuration)),
    Flag.withDescription("Complete policy JSON: presets, rules, and optional instructions"),
  ),
  ifVersion: ifVersionFlag,
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Replace a policy only if its version still matches; omit --if-version to read it first",
  ),
  Command.withExamples([
    {
      command:
        'samva policies set mailbox mbx_1234567890123456 --if-version 3 --data \'{"presets":[],"rules":[{"match":{},"atLeast":"person"}]}\' --dry-run --json',
    },
  ]),
  Command.withHandler(({ kind, id, data, ifVersion, dryRun, json }) =>
    Effect.gen(function* () {
      const resolveClient = yield* Effect.cached(getClientProvider);
      const version = Option.isSome(ifVersion)
        ? ifVersion.value
        : (yield* resolveClient.pipe(
            Effect.flatMap((client) =>
              Policies.getPolicy({ kind, id }).pipe(
                client.provide,
                Effect.mapError((error) =>
                  toCliApiError("Could not read policy before replacement", error),
                ),
              ),
            ),
          )).version;
      const request = { ...data, ifVersion: version };
      if (dryRun) {
        if (json)
          return yield* printJson({ dryRun: true, action: "policies.set", kind, id, request });
        yield* Console.log(
          `[dry-run] Would replace the ${kind} policy for ${id} at version ${version}.`,
        );
        return yield* printPolicy({ ...data, version });
      }
      const client = yield* resolveClient;
      const policy = yield* Policies.setPolicy({ kind, id, ...request }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not replace policy", error)),
      );
      yield* json ? printJson(policy) : printPolicy(policy);
    }),
  ),
);
const clear = Command.make("clear", {
  ...scope,
  ifVersion: ifVersionFlag,
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Clear a policy only if its version still matches, and retain the next version",
  ),
  Command.withExamples([
    {
      command: "samva policies clear mailbox mbx_1234567890123456 --if-version 3 --dry-run --json",
    },
  ]),
  Command.withHandler(({ kind, id, ifVersion, dryRun, json }) =>
    Effect.gen(function* () {
      const resolveClient = yield* Effect.cached(getClientProvider);
      const version = Option.isSome(ifVersion)
        ? ifVersion.value
        : (yield* resolveClient.pipe(
            Effect.flatMap((client) =>
              Policies.getPolicy({ kind, id }).pipe(
                client.provide,
                Effect.mapError((error) =>
                  toCliApiError("Could not read policy before clearing", error),
                ),
              ),
            ),
          )).version;
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "policies.clear", kind, id, ifVersion: version })
          : Console.log(
              `[dry-run] Would clear the ${kind} policy for ${id} at version ${version}.`,
            );
      const client = yield* resolveClient;
      const policy = yield* Policies.deletePolicy({ kind, id, ifVersion: version }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not clear policy", error)),
      );
      yield* json ? printJson(policy) : printPolicy(policy);
    }),
  ),
);

export const policiesCommand = Command.make("policies").pipe(
  Command.withDescription(
    "Decision rules and approval floors for organizations, mailboxes, and keys",
  ),
  Command.withSubcommands([get, set, clear]),
);
