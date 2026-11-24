import { AgentDefinition, MonthlySpendCapDollars } from "@samva/contracts/agents/group";
import { RunAgentTestPayload } from "@samva/contracts/agents/tests";
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

import { CliUsageError, toCliApiError } from "../errors";
import { buildAgent } from "../lib/agent-project";
import { getClientProvider } from "../lib/client";
import { deriveOverride } from "../lib/derive/curated";
import { jsonFlag, printFields, printJson } from "../lib/output";
import { readStdinUtf8 } from "../lib/stdin";
import { agentProjectCommands } from "./agents-project";

const list = deriveOverride(
  "list",
  {
    namespace: Flag.String("namespace").pipe(Flag.withSchema(NamespaceId), Flag.optional),
    limit: Flag.Int("limit").pipe(Flag.withDescription("Items per page"), Flag.optional),
    cursor: Flag.String("cursor").pipe(
      Flag.withDescription("Resume after nextCursor"),
      Flag.optional,
    ),
    json: jsonFlag,
  },
  {
    mapInput: ({ namespace, limit, cursor }) => ({
      namespaceId: Option.getOrUndefined(namespace),
      limit: Option.getOrUndefined(limit),
      cursor: Option.getOrUndefined(cursor),
    }),
    call: (request) => Agents.list(request),
    failure: "Could not list agents",
    render: (page) =>
      Effect.gen(function* () {
        for (const agent of page.items) {
          yield* printFields([
            ["ID", agent.id],
            ["Name", agent.name],
            ["Namespace", agent.namespaceId ?? "organization"],
          ]);
        }
        if (page.nextCursor !== null) yield* printFields([["Next cursor", page.nextCursor]]);
      }),
  },
).pipe(Command.withDescription("List hosted agents, optionally within one namespace"));

const create = deriveOverride(
  "create",
  {
    name: Argument.String("name").pipe(Argument.withSchema(AgentName)),
    setupJob: Flag.Literals("setup-job", AgentSetupJob.literals).pipe(
      Flag.withDescription("What the agent mostly does: support, store, or booking"),
      Flag.optional,
    ),
    namespace: Flag.String("namespace").pipe(Flag.withSchema(NamespaceId), Flag.optional),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    json: jsonFlag,
  },
  {
    mapInput: ({ name, setupJob, namespace }) => ({
      name,
      setupJob: Option.getOrUndefined(setupJob),
      namespaceId: Option.getOrUndefined(namespace),
    }),
    call: (request) => Agents.create(request),
    failure: "Could not create agent",
    preview: {
      data: (request) => ({ dryRun: true, action: "agents.create", request }),
      render: (request) => Console.log(`[dry-run] Would create hosted agent ${request.name}.`),
    },
    render: (agent) =>
      printFields([
        ["ID", agent.id],
        ["Name", agent.name],
        ["Setup job", agent.setupJob ?? "unstated"],
        ["Namespace", agent.namespaceId ?? "organization"],
      ]),
  },
).pipe(
  Command.withDescription("Create a hosted agent with an unpublished draft"),
  Command.withExamples([
    { command: 'samva agents create "Shop assistant" --setup-job store --json' },
    { command: 'samva agents create "Customer support" --dry-run --json' },
  ]),
);

const get = deriveOverride(
  "get",
  {
    agentId: Argument.String("agent-id").pipe(Argument.withSchema(AgentId)),
    json: jsonFlag,
  },
  {
    mapInput: ({ agentId }) => ({ id: agentId }),
    call: (request) => Agents.get(request),
    failure: "Could not get agent",
    render: (agent) =>
      Effect.gen(function* () {
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
          ["Event triggers", (agent.draft.eventTriggers ?? []).join(", ") || "none"],
          ["WhatsApp follow-up template", agent.draft.followUpTemplate ?? "none"],
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
  },
).pipe(
  Command.withDescription(
    "Inspect a hosted agent; use --json to include its full draft and revision",
  ),
  Command.withExamples([{ command: "samva agents get agt_1234567890123456 --json" }]),
);

const update = deriveOverride(
  "update",
  {
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
  },
  {
    prepare: ({ agentId, name, monthlySpendCap, removeSpendCap }) =>
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
        return {
          id: agentId,
          name: Option.getOrUndefined(name),
          monthlySpendCapDollars: removeSpendCap ? null : Option.getOrUndefined(monthlySpendCap),
        };
      }),
    call: (request) => Agents.update(request),
    failure: "Could not update agent",
    preview: {
      data: (request, input) => ({
        dryRun: true,
        action: "agents.update",
        agentId: input.agentId,
        request: { name: request.name, monthlySpendCapDollars: request.monthlySpendCapDollars },
      }),
      render: (request, input) =>
        printFields([
          ["Dry run", `Would update ${input.agentId}`],
          [
            "Request",
            JSON.stringify({
              name: request.name,
              monthlySpendCapDollars: request.monthlySpendCapDollars,
            }),
          ],
        ]),
    },
    render: (agent) =>
      printFields([
        ["ID", agent.id],
        ["Name", agent.name],
        [
          "Monthly spend cap",
          agent.monthlySpendCapDollars === null ? "none" : `$${agent.monthlySpendCapDollars}`,
        ],
      ]),
  },
).pipe(
  Command.withDescription(
    "Rename an agent or change its spend cap immediately, without publishing",
  ),
  Command.withExamples([
    { command: 'samva agents update agt_1234567890123456 --name "Shop assistant"' },
    { command: "samva agents update agt_1234567890123456 --monthly-spend-cap 25 --dry-run --json" },
    { command: "samva agents update agt_1234567890123456 --remove-spend-cap" },
  ]),
);

const replace = deriveOverride(
  "replace",
  {
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
  },
  {
    prepare: ({ agentId, revision, file }) =>
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
        return { id: agentId, revision, definition };
      }),
    call: (request) => Agents.replaceDraft(request),
    failure: "Could not replace agent draft",
    preview: {
      data: (request, input) => ({
        dryRun: true,
        action: "agents.draft.replace",
        agentId: input.agentId,
        request: { revision: request.revision, definition: request.definition },
      }),
      render: (request, input) =>
        printFields([
          ["Dry run", `Would replace draft for ${input.agentId}`],
          [
            "Request",
            JSON.stringify({ revision: request.revision, definition: request.definition }),
          ],
        ]),
    },
    render: (agent) =>
      Effect.gen(function* () {
        yield* printFields([
          ["ID", agent.id],
          ["Revision", agent.revision],
        ]);
        yield* Console.log("The draft is unpublished until you run samva agents publish.");
      }),
  },
).pipe(
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
);

const publish = Command.make("publish", {
  dir: Flag.String("dir").pipe(
    Flag.withDescription("Build a local agent module directory; evaluates its declaration locally"),
    Flag.optional,
  ),
  entry: Flag.String("entry").pipe(Flag.withDefault("agent.ts")),
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
    "Publish the draft, or --dir <directory> to build and publish a local module; without --revision reads the current revision",
  ),
  Command.withExamples([
    { command: "samva agents publish agt_1234567890123456 --json" },
    { command: "samva agents publish agt_1234567890123456 --dir ./support --json" },
    { command: "samva agents publish agt_1234567890123456 --revision <revision> --dry-run --json" },
  ]),
  Command.withHandler(({ agentId, revision, dir, entry, dryRun, json }) =>
    Effect.gen(function* () {
      const built = Option.isSome(dir) ? yield* buildAgent(dir.value, entry) : undefined;
      if (dryRun)
        return yield* json
          ? printJson({
              dryRun: true,
              action: "agents.publish",
              agentId,
              request: {
                revision: Option.getOrUndefined(revision),
                ...(built ? { bundle: { manifest: built.manifest, source: built.bundle } } : {}),
              },
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
      const result = yield* (
        built
          ? Agents.publishVersion({
              id: agentId,
              revision: currentRevision,
              bundle: { manifest: built.manifest, source: built.bundle },
            })
          : Agents.publish({ id: agentId, revision: currentRevision })
      ).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not publish agent", error)),
      );
      if (json) return yield* printJson(result);
      yield* Console.log(
        result.published
          ? `Published version ${result.version.version}`
          : `The ${built ? "module" : "draft"} matches version ${result.version.version}; nothing was published.`,
      );
    }),
  ),
);

const rerun = deriveOverride(
  "rerun",
  {
    agentId: Argument.String("agent-id").pipe(Argument.withSchema(AgentId)),
    data: Flag.String("data").pipe(
      Flag.withSchema(Schema.fromJsonString(RunAgentTestPayload)),
      Flag.withDescription("Draft JSON containing name and definition"),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    json: jsonFlag,
  },
  {
    mapInput: ({ agentId, data }) => ({ id: agentId, ...data }),
    call: (request) => Agents.rerunTests(request),
    failure: "Could not rerun agent tests",
    preview: {
      data: (_request, input) => ({
        dryRun: true,
        action: "agents.tests.rerun",
        agentId: input.agentId,
        request: input.data,
      }),
      render: (_request, input) =>
        Console.log(`[dry-run] Would compare saved-test decisions for ${input.agentId}.`),
    },
    render: (result) =>
      Effect.gen(function* () {
        if (result.items.length === 0) return yield* Console.log("No saved tests.");
        for (const test of result.items)
          yield* Console.log(
            `${test.testId}: ${test.changedDecisions.length} changed decisions${test.publishedDecisions === null ? " (no published version)" : ""}`,
          );
      }),
  },
).pipe(
  Command.withDescription("Rerun saved tests and compare draft decisions with the published agent"),
  Command.withExamples([
    { command: "samva agents tests rerun agt_1234567890123456 --data '<draft JSON>' --json" },
  ]),
);

export const agentsCommand = Command.make("agents").pipe(
  Command.withDescription("Hosted agents and saved tests"),
  Command.withSubcommands([
    ...agentProjectCommands,
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
    Command.make("tests").pipe(
      Command.withDescription("Run an agent's saved tests again"),
      Command.withSubcommands([rerun]),
    ),
  ]),
);
