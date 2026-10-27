import { JourneyDefinition } from "@samva/contracts/journeys/definition";
import { Effect, FileSystem, Schema } from "effect";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Journeys from "samva/effect/journeys";

import { CliUsageError, toCliApiError } from "../errors";
import { getClientProvider } from "../lib/client";
import { confirmDestructive } from "../lib/confirm";
import { jsonFlag, printFields, printJson, printJsonLine } from "../lib/output";
import { holdFields } from "../lib/run-hold";
import { isJsonLinesRequested } from "../lib/runtime";
import { readStdinUtf8 } from "../lib/stdin";

const JOURNEY_STATUSES = ["draft", "active", "paused", "archived"] as const;
const RUN_STATUSES = ["active", "paused", "exited", "failed"] as const;

const quietWhenJson = (json: boolean) =>
  json ? Effect.provideService(References.MinimumLogLevel, "None") : identity;

const cursorFlag = Flag.String("cursor").pipe(
  Flag.withDescription("Resume after this nextCursor from a previous page"),
  Flag.optional,
);
const limitFlag = Flag.Int("limit").pipe(Flag.withDescription("Items per page"), Flag.optional);
const allFlag = Flag.Boolean("all").pipe(
  Flag.withDescription("Traverse every page (requires --jsonl)"),
  Flag.withDefault(false),
);
const revisionFlag = Flag.String("revision").pipe(
  Flag.withDescription("The journey's revision from your last read; a stale one is refused (409)"),
);
const nameFlag = Flag.String("name").pipe(Flag.withDescription("Journey name"));
const definitionFlag = Flag.String("definition").pipe(
  Flag.withDescription("Journey definition JSON, @file, or - for piped stdin"),
);
const idArgument = Argument.String("id").pipe(Argument.withDescription("Journey ID"));

/** Resolves a JSON flag value that is inline, `@file`, or `-` (stdin). */
const readJsonSource = (flag: string, data: string) =>
  Effect.gen(function* () {
    let source = data;
    if (data === "-") source = yield* readStdinUtf8;
    else if (data.startsWith("@")) {
      const path = data.slice(1);
      if (!path)
        return yield* new CliUsageError({
          code: "missing_data_file",
          message: `--${flag} @ requires a file path. Try: samva journeys create --${flag} @journey.json`,
        });
      const fs = yield* FileSystem.FileSystem;
      source = yield* fs.readFileString(path).pipe(
        Effect.mapError(
          () =>
            new CliUsageError({
              code: "data_file_unreadable",
              message: `Could not read --${flag} from ${path}.`,
            }),
        ),
      );
    }
    return yield* Effect.try({
      try: () => JSON.parse(source) as unknown,
      catch: () =>
        new CliUsageError({
          code: "definition_invalid_json",
          message: `--${flag} must be valid JSON. Try: samva journeys create --help`,
        }),
    });
  });

const decodeDefinition = Schema.decodeUnknownEffect(JourneyDefinition);

/**
 * Reads `--definition` and checks it against the journey contract, graph rules included, so a
 * bad definition fails before any request. The request carries the JSON as written.
 */
const readDefinition = (data: string) =>
  Effect.gen(function* () {
    const body = yield* readJsonSource("definition", data);
    yield* decodeDefinition(body).pipe(
      Effect.mapError(
        (error) =>
          new CliUsageError({
            code: "definition_invalid",
            message: `--definition is not a valid journey definition: ${error.message}`,
          }),
      ),
    );
    return body;
  });

const printJourney = (journey: {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly publishedVersion: number | null;
  readonly publishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision?: string | undefined;
}) =>
  printFields([
    ["ID", journey.id],
    ["Name", journey.name],
    ["Status", journey.status],
    ["Revision", journey.revision],
    ["Published version", journey.publishedVersion],
    ["Published", journey.publishedAt],
    ["Created", journey.createdAt],
    ["Updated", journey.updatedAt],
  ]);

const requireJsonLines = (all: boolean) =>
  all && !isJsonLinesRequested()
    ? new CliUsageError({
        code: "all_requires_jsonl",
        message: "--all is an unbounded traversal and requires --jsonl.",
      })
    : undefined;

const list = Command.make("list", {
  status: Flag.Literals("status", JOURNEY_STATUSES).pipe(
    Flag.withDescription("Filter by status"),
    Flag.optional,
  ),
  cursor: cursorFlag,
  limit: limitFlag,
  all: allFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List journeys"),
  Command.withExamples([
    { command: "samva journeys list" },
    { command: "samva journeys list --status active --json" },
    { command: "samva journeys list --all --jsonl", description: "Stream every page as JSONL" },
  ]),
  Command.withHandler(({ status, cursor, limit, all, json }) =>
    Effect.gen(function* () {
      const usage = requireJsonLines(all);
      if (usage) return yield* usage;
      const client = yield* getClientProvider;
      let nextCursor = Option.getOrUndefined(cursor);
      for (;;) {
        const page = yield* Journeys.list({
          status: Option.getOrUndefined(status),
          cursor: nextCursor,
          limit: Option.getOrUndefined(limit),
        }).pipe(
          client.provide,
          Effect.mapError((error) =>
            toCliApiError("Could not list journeys", error, { cursor: nextCursor ?? null }),
          ),
        );
        if (isJsonLinesRequested()) {
          for (const item of page.items) yield* printJsonLine(item);
        } else if (json) return yield* printJson(page);
        else {
          if (page.items.length === 0)
            yield* Console.log("No journeys yet. Create one with `samva journeys create`.");
          for (const item of page.items) {
            yield* printJourney(item);
            yield* Console.log("");
          }
          if (page.nextCursor !== null) yield* printFields([["Next cursor", page.nextCursor]]);
        }
        if (!all || page.nextCursor === null) return;
        nextCursor = page.nextCursor;
      }
    }).pipe(quietWhenJson(json)),
  ),
);

const get = Command.make("get", { id: idArgument, json: jsonFlag }).pipe(
  Command.withDescription("Show a journey with its draft definition and revision"),
  Command.withExamples([{ command: "samva journeys get jrny_7q2xk9mvt4znw8rh --json" }]),
  Command.withHandler(({ id, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const journey = yield* Journeys.get({ id }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not fetch journey", error)),
      );
      if (json) return yield* printJson(journey);
      yield* printJourney(journey);
      yield* printFields([["Trigger", JSON.stringify(journey.draft.trigger)]]);
      yield* printFields([["Draft nodes", Object.keys(journey.draft.nodes).length]]);
    }).pipe(quietWhenJson(json)),
  ),
);

const create = Command.make("create", {
  name: nameFlag,
  definition: definitionFlag,
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Validate the definition offline without creating a journey"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create a draft journey from a definition"),
  Command.withExamples([
    { command: `samva journeys create --name "Welcome" --definition @welcome.json --json` },
    { command: `cat welcome.json | samva journeys create --name "Welcome" --definition -` },
  ]),
  Command.withHandler(({ name, definition, dryRun, json }) =>
    Effect.gen(function* () {
      const body = yield* readDefinition(definition);
      const payload = { name, definition: body } as Parameters<typeof Journeys.create>[0];
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "journeys.create", request: payload })
          : printFields([
              ["Dry run", true],
              ["Journey", name],
            ]);
      const client = yield* getClientProvider;
      const journey = yield* Journeys.create(payload).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not create journey", error)),
      );
      if (json) return yield* printJson(journey);
      yield* printJourney(journey);
    }).pipe(quietWhenJson(json)),
  ),
);

const rename = Command.make("rename", { id: idArgument, name: nameFlag, json: jsonFlag }).pipe(
  Command.withDescription("Rename a journey"),
  Command.withExamples([
    { command: `samva journeys rename jrny_7q2xk9mvt4znw8rh --name "Onboarding"` },
  ]),
  Command.withHandler(({ id, name, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const journey = yield* Journeys.update({ id, name }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not rename journey", error)),
      );
      if (json) return yield* printJson(journey);
      yield* printJourney(journey);
    }).pipe(quietWhenJson(json)),
  ),
);

const draft = Command.make("draft", {
  id: idArgument,
  revision: revisionFlag,
  definition: definitionFlag,
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Validate the definition offline without replacing the draft"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Replace a journey's draft definition"),
  Command.withExamples([
    {
      command:
        "samva journeys draft jrny_7q2xk9mvt4znw8rh --revision <revision> --definition @welcome.json --json",
    },
  ]),
  Command.withHandler(({ id, revision, definition, dryRun, json }) =>
    Effect.gen(function* () {
      const body = yield* readDefinition(definition);
      const payload = { id, revision, definition: body } as Parameters<
        typeof Journeys.replaceDraft
      >[0];
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "journeys.draft", request: payload })
          : printFields([
              ["Dry run", true],
              ["Journey", id],
            ]);
      const client = yield* getClientProvider;
      const journey = yield* Journeys.replaceDraft(payload).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not replace journey draft", error)),
      );
      if (json) return yield* printJson(journey);
      yield* printJourney(journey);
    }).pipe(quietWhenJson(json)),
  ),
);

const publish = Command.make("publish", {
  id: idArgument,
  revision: revisionFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Publish the draft as the next immutable version"),
  Command.withExamples([
    { command: "samva journeys publish jrny_7q2xk9mvt4znw8rh --revision <revision> --json" },
  ]),
  Command.withHandler(({ id, revision, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const journey = yield* Journeys.publish({ id, revision }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not publish journey", error)),
      );
      if (json) return yield* printJson(journey);
      yield* Effect.logInfo("Journey published.\n");
      yield* printJourney(journey);
    }).pipe(quietWhenJson(json)),
  ),
);

type ClientServices = Effect.Services<ReturnType<typeof Journeys.pause>>;

const transition = <E>(
  name: "pause" | "resume",
  description: string,
  operation: (input: {
    readonly id: string;
  }) => Effect.Effect<Parameters<typeof printJourney>[0], E, ClientServices>,
  failure: string,
) =>
  Command.make(name, { id: idArgument, json: jsonFlag }).pipe(
    Command.withDescription(description),
    Command.withExamples([{ command: `samva journeys ${name} jrny_7q2xk9mvt4znw8rh` }]),
    Command.withHandler(({ id, json }) =>
      Effect.gen(function* () {
        const client = yield* getClientProvider;
        const journey = yield* operation({ id }).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError(failure, error)),
        );
        if (json) return yield* printJson(journey);
        yield* printJourney(journey);
      }).pipe(quietWhenJson(json)),
    ),
  );

const pause = transition(
  "pause",
  "Emergency stop: admit no new contacts and hold active runs before their next step",
  Journeys.pause,
  "Could not pause journey",
);
const resume = transition(
  "resume",
  "Resume enrollment and continue the runs a pause held",
  Journeys.resume,
  "Could not resume journey",
);

const destructive = <E>(
  name: "archive" | "delete",
  description: string,
  warning: string,
  run: (id: string) => Effect.Effect<{ readonly id: string }, E, ClientServices>,
  failure: string,
) =>
  Command.make(name, {
    id: idArgument,
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
    json: jsonFlag,
  }).pipe(
    Command.withDescription(description),
    Command.withExamples([
      { command: `samva journeys ${name} jrny_7q2xk9mvt4znw8rh --dry-run` },
      { command: `samva journeys ${name} jrny_7q2xk9mvt4znw8rh --yes` },
    ]),
    Command.withHandler(({ id, dryRun, yes, json }) =>
      Effect.gen(function* () {
        if (dryRun)
          return yield* json
            ? printJson({ dryRun: true, action: `journeys.${name}`, id })
            : Console.log(`[dry-run] Would ${name} journey ${id}.`);
        yield* confirmDestructive({
          yes,
          json,
          message: `${warning} Journey ${id}?`,
          nonInteractiveMessage: `Journey ${name} requires --yes in non-interactive mode. Preview with --dry-run.`,
        });
        const client = yield* getClientProvider;
        const result = yield* run(id).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError(failure, error)),
        );
        if (json) return yield* printJson(result);
        yield* printFields([
          ["ID", result.id],
          ["Result", name === "delete" ? "deleted" : "archived"],
        ]);
      }).pipe(quietWhenJson(json)),
    ),
  );

const archive = destructive(
  "archive",
  "Archive a journey and exit its active runs",
  "Archive and exit every active run of",
  (id) => Journeys.archive({ id }),
  "Could not archive journey",
);
const remove = destructive(
  "delete",
  "Delete a never-published or archived journey with its versions and runs",
  "Permanently delete",
  (id) => Journeys.remove({ id }),
  "Could not delete journey",
);

const getVersion = Command.make("version", {
  id: idArgument,
  version: Argument.Int("version").pipe(Argument.withDescription("Published version number")),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show one immutable published definition"),
  Command.withExamples([{ command: "samva journeys version jrny_7q2xk9mvt4znw8rh 2 --json" }]),
  Command.withHandler(({ id, version, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Journeys.getVersion({ id, version: String(version) }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not fetch journey version", error)),
      );
      // A definition is a graph; the one-result contract is JSON in both modes.
      yield* printJson(data);
    }).pipe(quietWhenJson(json)),
  ),
);

const stats = Command.make("stats", {
  id: idArgument,
  version: Flag.Int("version").pipe(
    Flag.withDescription("Published version (default: newest)"),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Count a published version's runs by status and by node"),
  Command.withExamples([{ command: "samva journeys stats jrny_7q2xk9mvt4znw8rh --json" }]),
  Command.withHandler(({ id, version, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Journeys.stats({
        id,
        version: Option.getOrUndefined(version),
      }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not fetch journey stats", error)),
      );
      if (json) return yield* printJson(data);
      yield* printFields([
        ["Version", data.version],
        ["Active", data.runs.active],
        ["Paused", data.runs.paused],
        ["Exited", data.runs.exited],
        ["Failed", data.runs.failed],
      ]);
      for (const node of data.nodes)
        yield* Console.log(`${node.nodeId}  now ${node.current}  entered ${node.entered}`);
    }).pipe(quietWhenJson(json)),
  ),
);

const printRun = (run: {
  readonly id: string;
  readonly journeyId: string;
  readonly version: number;
  readonly contactId: string;
  readonly status: string;
  readonly exitReason: string | null;
  readonly failureReason: string | null;
  readonly currentNodeId: string | null;
  readonly enteredAt: string;
  readonly endedAt: string | null;
  readonly holdReason?: string | null;
  readonly holdUntil?: string | null;
}) =>
  printFields([
    ["Run ID", run.id],
    ["Journey", run.journeyId],
    ["Version", run.version],
    ["Contact", run.contactId],
    ["Status", run.status],
    ["Exit reason", run.exitReason],
    ["Failure", run.failureReason],
    ["Current node", run.currentNodeId],
    ...holdFields(run),
    ["Entered", run.enteredAt],
    ["Ended", run.endedAt],
  ]);

const runList = Command.make("list", {
  id: idArgument,
  status: Flag.Literals("status", RUN_STATUSES).pipe(
    Flag.withDescription("Filter by run status"),
    Flag.optional,
  ),
  contact: Flag.String("contact").pipe(Flag.withDescription("Filter by contact ID"), Flag.optional),
  cursor: cursorFlag,
  limit: limitFlag,
  all: allFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List a journey's runs, newest first"),
  Command.withExamples([
    { command: "samva journeys runs list jrny_7q2xk9mvt4znw8rh --status active --json" },
    { command: "samva journeys runs list jrny_7q2xk9mvt4znw8rh --all --jsonl" },
  ]),
  Command.withHandler(({ id, status, contact, cursor, limit, all, json }) =>
    Effect.gen(function* () {
      const usage = requireJsonLines(all);
      if (usage) return yield* usage;
      const client = yield* getClientProvider;
      let nextCursor = Option.getOrUndefined(cursor);
      for (;;) {
        const page = yield* Journeys.listRuns({
          id,
          status: Option.getOrUndefined(status),
          contactId: Option.getOrUndefined(contact),
          cursor: nextCursor,
          limit: Option.getOrUndefined(limit),
        }).pipe(
          client.provide,
          Effect.mapError((error) =>
            toCliApiError("Could not list journey runs", error, { cursor: nextCursor ?? null }),
          ),
        );
        if (isJsonLinesRequested()) {
          for (const run of page.items) yield* printJsonLine(run);
        } else if (json) return yield* printJson(page);
        else {
          if (page.items.length === 0) yield* Console.log("No runs found.");
          for (const run of page.items) {
            yield* printRun(run);
            yield* Console.log("");
          }
          if (page.nextCursor !== null) yield* printFields([["Next cursor", page.nextCursor]]);
        }
        if (!all || page.nextCursor === null) return;
        nextCursor = page.nextCursor;
      }
    }).pipe(quietWhenJson(json)),
  ),
);

const runGet = Command.make("get", {
  id: idArgument,
  runId: Argument.String("run").pipe(Argument.withDescription("Run ID")),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show one run with every node it entered, in order"),
  Command.withExamples([
    { command: "samva journeys runs get jrny_7q2xk9mvt4znw8rh jrun_7q2xk9mvt4znw8rh --json" },
  ]),
  Command.withHandler(({ id, runId, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const run = yield* Journeys.getRun({ id, runId }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not fetch journey run", error)),
      );
      if (json) return yield* printJson(run);
      yield* printRun(run);
      yield* printFields([["Trigger event", `${run.trigger.eventName} (${run.trigger.eventId})`]]);
      for (const step of run.steps) {
        yield* Console.log("");
        yield* printFields([
          ["Node", `${step.nodeId} (${step.type})`],
          ["Entered", step.enteredAt],
          ["Completed", step.completedAt],
          ["Outcome", step.outcome],
          ["Next", step.nextNodeId],
          ["Message", step.messageId],
          ["Error", step.error],
        ]);
      }
    }).pipe(quietWhenJson(json)),
  ),
);

const runs = Command.make("runs").pipe(
  Command.withDescription("Read a journey's runs"),
  Command.withSubcommands([runList, runGet]),
);

export const journeysCommand = Command.make("journeys").pipe(
  Command.withDescription("Create, publish, pause, and observe event-triggered journeys"),
  Command.withSubcommands([
    list,
    get,
    create,
    rename,
    draft,
    publish,
    pause,
    resume,
    archive,
    remove,
    getVersion,
    stats,
    runs,
  ]),
);
