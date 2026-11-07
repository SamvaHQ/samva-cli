import { AgentTestRerun, RunAgentTestPayload } from "@samva/contracts/agents/setup-group";
import { AgentId, NamespaceId } from "@samva/core/shared/base";
import { Console, Effect, Schema } from "effect";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Option from "effect/Option";
import * as Agents from "samva/effect/agents";

import { SamvaCliError, toCliApiError } from "../errors";
import { getClientProvider, postAuthenticatedJson } from "../lib/client";
import { jsonFlag, printFields, printJson } from "../lib/output";

const list = Command.make("list", {
  namespace: Flag.String("namespace").pipe(Flag.withSchema(NamespaceId), Flag.optional),
  limit: Flag.Int("limit").pipe(Flag.withDescription("Items per page"), Flag.optional),
  cursor: Flag.String("cursor").pipe(
    Flag.withDescription("Resume after nextCursor"),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List hosted agents, optionally within one namespace"),
  Command.withHandler(({ namespace, limit, cursor, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const page = yield* Agents.list({
        namespaceId: Option.getOrUndefined(namespace),
        limit: Option.getOrUndefined(limit),
        cursor: Option.getOrUndefined(cursor),
      }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not list agents", error)),
      );
      if (json) return yield* printJson(page);
      for (const agent of page.items) {
        yield* printFields([
          ["ID", agent.id],
          ["Name", agent.name],
          ["Namespace", agent.namespaceId ?? "organization"],
        ]);
      }
      if (page.nextCursor !== null) yield* printFields([["Next cursor", page.nextCursor]]);
    }),
  ),
);

const rerun = Command.make("rerun", {
  agentId: Argument.String("agent-id").pipe(Argument.withSchema(AgentId)),
  data: Flag.String("data").pipe(
    Flag.withSchema(Schema.fromJsonString(RunAgentTestPayload)),
    Flag.withDescription("Draft JSON containing name and definition"),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Rerun saved tests and compare draft decisions with the published agent"),
  Command.withExamples([
    { command: "samva agents tests rerun agt_1234567890123456 --data '<draft JSON>' --json" },
  ]),
  Command.withHandler(({ agentId, data, dryRun, json }) =>
    Effect.gen(function* () {
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "agents.tests.rerun", agentId, request: data })
          : Console.log(`[dry-run] Would compare saved-test decisions for ${agentId}.`);
      const raw = yield* postAuthenticatedJson(
        `/v1/agents/${encodeURIComponent(agentId)}/tests/rerun`,
        { body: data },
      );
      const result = yield* Schema.decodeUnknownEffect(AgentTestRerun)(raw).pipe(
        Effect.mapError(
          () => new SamvaCliError({ message: "The API returned an invalid test comparison." }),
        ),
      );
      if (json) return yield* printJson(result);
      if (result.items.length === 0) return yield* Console.log("No saved tests.");
      for (const test of result.items)
        yield* Console.log(
          `${test.testId}: ${test.changedDecisions.length} changed decisions${test.publishedDecisions === null ? " (no published version)" : ""}`,
        );
    }),
  ),
);

export const agentsCommand = Command.make("agents").pipe(
  Command.withDescription("Hosted agents and saved tests"),
  Command.withSubcommands([list, Command.make("tests").pipe(Command.withSubcommands([rerun]))]),
);
