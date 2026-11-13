import { AgentDefinition, MonthlySpendCapDollars } from "@samva/contracts/agents/group";
import { AgentTestRerun, RunAgentTestPayload } from "@samva/contracts/agents/setup-group";
import { AgentName } from "@samva/core/agents/definition";
import { AgentSetupJob } from "@samva/core/agents/presets";
import { AgentId, NamespaceId } from "@samva/core/shared/base";
import { Console, Effect, Schema } from "effect";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Agents from "samva/effect/agents";

import { CliUsageError, SamvaCliError, toCliApiError } from "../errors";
import { getClientProvider, postAuthenticatedJson } from "../lib/client";
import { jsonFlag, printFields, printJson } from "../lib/output";
import { readStdinUtf8 } from "../lib/stdin";

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

const create = Command.make("create", {
  name: Argument.String("name").pipe(Argument.withSchema(AgentName)),
  setupJob: Flag.Literals("setup-job", AgentSetupJob.literals).pipe(
    Flag.withDescription("What the agent mostly does: support, store, or booking"),
    Flag.optional,
  ),
  namespace: Flag.String("namespace").pipe(Flag.withSchema(NamespaceId), Flag.optional),
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create a hosted agent with an unpublished draft"),
  Command.withExamples([
    { command: 'samva agents create "Shop assistant" --setup-job store --json' },
    { command: 'samva agents create "Customer support" --dry-run --json' },
  ]),
  Command.withHandler(({ name, setupJob, namespace, dryRun, json }) =>
    Effect.gen(function* () {
      const request = {
        name,
        setupJob: Option.getOrUndefined(setupJob),
        namespaceId: Option.getOrUndefined(namespace),
      };
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "agents.create", request })
          : Console.log(`[dry-run] Would create hosted agent ${name}.`);
      const client = yield* getClientProvider;
      const agent = yield* Agents.create(request).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not create agent", error)),
      );
      if (json) return yield* printJson(agent);
      yield* printFields([
        ["ID", agent.id],
        ["Name", agent.name],
        ["Setup job", agent.setupJob ?? "unstated"],
        ["Namespace", agent.namespaceId ?? "organization"],
      ]);
    }),
  ),
);

const get = Command.make("get", {
  agentId: Argument.String("agent-id").pipe(Argument.withSchema(AgentId)),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Inspect a hosted agent; use --json to include its full draft and revision",
  ),
  Command.withExamples([{ command: "samva agents get agt_1234567890123456 --json" }]),
  Command.withHandler(({ agentId, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const agent = yield* Agents.get({ id: agentId }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not get agent", error)),
      );
      if (json) return yield* printJson(agent);
      const pauses = [
        agent.pausedAt ? "owner pause" : undefined,
        agent.creditsPausedAt ? "credits pause" : undefined,
        agent.spend.capReachedAt !== null &&
        agent.monthlySpendCapDollars !== null &&
        agent.spend.spentDollars >= agent.monthlySpendCapDollars
          ? "spend cap"
          : undefined,
      ].filter((pause) => pause !== undefined);
      yield* printFields([
        ["ID", agent.id],
        ["Name", agent.name],
        ["Setup job", agent.setupJob ?? "unstated"],
        ["Namespace", agent.namespaceId ?? "organization"],
        ["Revision", agent.revision],
        ["Published version", agent.publishedVersion ?? "unpublished"],
        ["Published at", agent.publishedAt ?? "unpublished"],
        ["Paused", pauses.length > 0 ? pauses.join(", ") : "no"],
        [
          "Monthly spend cap",
          agent.monthlySpendCapDollars === null ? "none" : `$${agent.monthlySpendCapDollars}`,
        ],
        ["Spent this month", `$${agent.spend.spentDollars}`],
      ]);
    }),
  ),
);

const update = Command.make("update", {
  agentId: Argument.String("agent-id").pipe(Argument.withSchema(AgentId)),
  name: Flag.String("name").pipe(Flag.withSchema(AgentName), Flag.optional),
  monthlySpendCap: Flag.Finite("monthly-spend-cap").pipe(
    Flag.withSchema(MonthlySpendCapDollars),
    Flag.withDescription("Monthly spend cap in dollars and whole cents"),
    Flag.optional,
  ),
  removeSpendCap: Flag.Boolean("remove-spend-cap").pipe(Flag.withDefault(false)),
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Rename an agent or change its spend cap immediately, without publishing",
  ),
  Command.withExamples([
    { command: 'samva agents update agt_1234567890123456 --name "Shop assistant"' },
    { command: "samva agents update agt_1234567890123456 --monthly-spend-cap 25 --dry-run --json" },
    { command: "samva agents update agt_1234567890123456 --remove-spend-cap" },
  ]),
  Command.withHandler(({ agentId, name, monthlySpendCap, removeSpendCap, dryRun, json }) =>
    Effect.gen(function* () {
      if (Option.isSome(monthlySpendCap) && removeSpendCap)
        return yield* new CliUsageError({
          code: "agent_spend_cap_conflict",
          message: "Use either --monthly-spend-cap or --remove-spend-cap, not both.",
        });
      if (Option.isNone(name) && Option.isNone(monthlySpendCap) && !removeSpendCap)
        return yield* new CliUsageError({
          code: "agent_update_empty",
          message:
            "Provide --name, --monthly-spend-cap, or --remove-spend-cap. Example: samva agents update agt_1234567890123456 --monthly-spend-cap 25",
        });
      const request = {
        name: Option.getOrUndefined(name),
        monthlySpendCapDollars: removeSpendCap ? null : Option.getOrUndefined(monthlySpendCap),
      };
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "agents.update", agentId, request })
          : printFields([
              ["Dry run", `Would update ${agentId}`],
              ["Request", JSON.stringify(request)],
            ]);
      const client = yield* getClientProvider;
      const agent = yield* Agents.update({ id: agentId, ...request }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not update agent", error)),
      );
      if (json) return yield* printJson(agent);
      yield* printFields([
        ["ID", agent.id],
        ["Name", agent.name],
        [
          "Monthly spend cap",
          agent.monthlySpendCapDollars === null ? "none" : `$${agent.monthlySpendCapDollars}`,
        ],
      ]);
    }),
  ),
);

const replace = Command.make("replace", {
  agentId: Argument.String("agent-id").pipe(Argument.withSchema(AgentId)),
  revision: Flag.String("revision").pipe(
    Flag.withSchema(Schema.NonEmptyString),
    Flag.withDescription("Revision from the last agent read; stale revisions return HTTP 409"),
  ),
  file: Flag.String("file").pipe(
    Flag.withDescription("AgentDefinition JSON file, or - for piped stdin"),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Replace the entire draft definition; publishing is a separate command"),
  Command.withExamples([
    {
      command:
        "samva agents draft replace agt_1234567890123456 --revision <revision> --file draft.json --json",
    },
    {
      command:
        "cat draft.json | samva agents draft replace agt_1234567890123456 --revision <revision> --file - --dry-run --json",
    },
  ]),
  Command.withHandler(({ agentId, revision, file, dryRun, json }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const source = yield* file === "-"
        ? readStdinUtf8
        : fs.readFileString(file).pipe(
            Effect.mapError(
              () =>
                new CliUsageError({
                  code: "agent_draft_file_unreadable",
                  message: `Could not read draft file ${file}. Pass --file <path> or pipe JSON with --file -.`,
                }),
            ),
          );
      const definition = yield* Schema.decodeEffect(Schema.fromJsonString(AgentDefinition))(
        source,
      ).pipe(
        Effect.mapError(
          (error) =>
            new CliUsageError({
              code: "agent_draft_invalid",
              message: `Invalid AgentDefinition JSON in ${file}: ${error.message}. Supply the draft from samva agents get <agent-id> --json | jq .data.draft.`,
            }),
        ),
      );
      const request = { revision, definition };
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "agents.draft.replace", agentId, request })
          : printFields([
              ["Dry run", `Would replace draft for ${agentId}`],
              ["Request", JSON.stringify(request)],
            ]);
      const client = yield* getClientProvider;
      const agent = yield* Agents.replaceDraft({ id: agentId, ...request }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not replace agent draft", error)),
      );
      if (json) return yield* printJson(agent);
      yield* printFields([
        ["ID", agent.id],
        ["Revision", agent.revision],
      ]);
      yield* Console.log("The draft is unpublished until you run samva agents publish.");
    }),
  ),
);

const publish = Command.make("publish", {
  agentId: Argument.String("agent-id").pipe(Argument.withSchema(AgentId)),
  revision: Flag.String("revision").pipe(
    Flag.withSchema(Schema.NonEmptyString),
    Flag.withDescription(
      "Revision to publish; omitted, reads the agent and publishes its current revision",
    ),
    Flag.optional,
  ),
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Publish the draft; without --revision, reads and publishes the current revision",
  ),
  Command.withExamples([
    { command: "samva agents publish agt_1234567890123456 --json" },
    { command: "samva agents publish agt_1234567890123456 --revision <revision> --dry-run --json" },
  ]),
  Command.withHandler(({ agentId, revision, dryRun, json }) =>
    Effect.gen(function* () {
      if (dryRun)
        return yield* json
          ? printJson({
              dryRun: true,
              action: "agents.publish",
              agentId,
              request: { revision: Option.getOrUndefined(revision) },
              ...(Option.isNone(revision)
                ? { resolveRevision: "Read the agent's current revision before publishing" }
                : {}),
            })
          : Console.log(
              `[dry-run] Would publish ${agentId} at ${Option.getOrElse(revision, () => "its current revision (read before publishing)")}.`,
            );
      const client = yield* getClientProvider;
      const currentRevision = Option.isSome(revision)
        ? revision.value
        : (yield* Agents.get({ id: agentId }).pipe(
            client.provide,
            Effect.mapError((error) =>
              toCliApiError("Could not read agent revision before publishing", error),
            ),
          )).revision;
      const result = yield* Agents.publish({ id: agentId, revision: currentRevision }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not publish agent", error)),
      );
      if (json) return yield* printJson(result);
      yield* Console.log(
        result.published
          ? `Published version ${result.version.version}`
          : `The draft matches version ${result.version.version}; nothing was published.`,
      );
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
  Command.withSubcommands([
    list,
    create,
    get,
    update,
    Command.make("draft").pipe(
      Command.withDescription("Edit an unpublished agent draft"),
      Command.withExamples([
        {
          command:
            "samva agents draft replace agt_1234567890123456 --revision <revision> --file draft.json",
        },
      ]),
      Command.withSubcommands([replace]),
    ),
    publish,
    Command.make("tests").pipe(Command.withSubcommands([rerun])),
  ]),
);
