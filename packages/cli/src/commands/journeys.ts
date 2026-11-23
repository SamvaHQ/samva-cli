import {
  ConnectionHandoffProvider,
  ConnectionHandoffQuery,
  TestHandoffQuery,
} from "@samva/contracts/integrations/recipe-handoffs";
import {
  ActivateRecipeSetup,
  RecipeSetupId,
  ReplaceRecipeSetup,
} from "@samva/contracts/integrations/recipe-setup";
import {
  RecipePreviewPayload,
  RecipeTestPayload,
  RecipeTestRequestId,
} from "@samva/contracts/integrations/recipe-tests";
import { RecipeReadinessQuery } from "@samva/contracts/integrations/recipes";
import { JourneyDefinition } from "@samva/core/journeys/definition";
import {
  EmailSenderId,
  IntegrationAccountId,
  MailboxEndpointId,
  TemplatePublicationId,
  TemplateRegistrationId,
  WhatsAppBusinessAccountId,
} from "@samva/core/shared/base";
import { Effect, FileSystem, Schema } from "effect";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Option from "effect/Option";
import * as IntegrationsCatalog from "samva/effect/integrations-catalog";
import * as Journeys from "samva/effect/journeys";

import { CliUsageError, toCliApiError } from "../errors";
import { deriveOverride } from "../lib/derive/curated";
import { jsonFlag, printFields, printJson } from "../lib/output";
import { holdFields } from "../lib/run-hold";
import { readStdinUtf8 } from "../lib/stdin";

const JOURNEY_STATUSES = ["draft", "active", "paused", "archived"] as const;
const RUN_STATUSES = ["active", "paused", "exited", "failed"] as const;

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

const decodeDefinition = Schema.decodeUnknownEffect(JourneyDefinition, {
  onExcessProperty: "error",
  errors: "all",
});

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

const list = deriveOverride(
  "list",
  {
    status: Flag.Literals("status", JOURNEY_STATUSES).pipe(
      Flag.withDescription("Filter by status"),
      Flag.optional,
    ),
    cursor: cursorFlag,
    limit: limitFlag,
    all: allFlag,
    json: jsonFlag,
  },
  {
    mapInput: ({ status, cursor, limit }) => ({
      status: Option.getOrUndefined(status),
      cursor: Option.getOrUndefined(cursor),
      limit: Option.getOrUndefined(limit),
    }),
    call: (request) => Journeys.list(request),
    failure: (error, request) =>
      toCliApiError("Could not list journeys", error, { cursor: request.cursor ?? null }),
    paginate: {
      withCursor: (request, cursor) => ({ ...request, cursor }),
      start: (request) => request.cursor,
    },
    render: (page) =>
      Effect.gen(function* () {
        if (page.items.length === 0)
          yield* Console.log("No journeys yet. Create one with `samva journeys create`.");
        for (const item of page.items) {
          yield* printJourney(item);
          yield* Console.log("");
        }
        if (page.nextCursor !== null) yield* printFields([["Next cursor", page.nextCursor]]);
      }),
  },
).pipe(
  Command.withDescription("List journeys"),
  Command.withExamples([
    { command: "samva journeys list" },
    { command: "samva journeys list --status active --json" },
    { command: "samva journeys list --all --jsonl", description: "Stream every page as JSONL" },
  ]),
);

const get = deriveOverride(
  "get",
  { id: idArgument, json: jsonFlag },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => Journeys.get(request),
    failure: "Could not fetch journey",
    render: (journey) =>
      Effect.gen(function* () {
        yield* printJourney(journey);
        yield* printFields([["Trigger", JSON.stringify(journey.draft.trigger)]]);
        yield* printFields([["Draft nodes", Object.keys(journey.draft.nodes).length]]);
      }),
  },
).pipe(
  Command.withDescription("Show a journey with its draft definition and revision"),
  Command.withExamples([{ command: "samva journeys get jrny_7q2xk9mvt4znw8rh --json" }]),
);

const create = deriveOverride(
  "create",
  {
    name: nameFlag,
    definition: definitionFlag,
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Validate the definition offline without creating a journey"),
      Flag.withDefault(false),
    ),
    json: jsonFlag,
  },
  {
    prepare: ({ name, definition }) =>
      readDefinition(definition).pipe(
        Effect.map((body) => ({ name, definition: body }) as Parameters<typeof Journeys.create>[0]),
      ),
    call: (request) => Journeys.create(request),
    failure: "Could not create journey",
    preview: {
      data: (request) => ({ dryRun: true, action: "journeys.create", request }),
      render: (request) =>
        printFields([
          ["Dry run", true],
          ["Journey", request.name],
        ]),
    },
    render: (journey) => printJourney(journey),
  },
).pipe(
  Command.withDescription("Create a draft journey from a definition"),
  Command.withExamples([
    { command: `samva journeys create --name "Welcome" --definition @welcome.json --json` },
    { command: `cat welcome.json | samva journeys create --name "Welcome" --definition -` },
  ]),
);

const rename = deriveOverride(
  "rename",
  { id: idArgument, name: nameFlag, json: jsonFlag },
  {
    mapInput: ({ id, name }) => ({ id, name }),
    call: (request) => Journeys.update(request),
    failure: "Could not rename journey",
    render: (journey) => printJourney(journey),
  },
).pipe(
  Command.withDescription("Rename a journey"),
  Command.withExamples([
    { command: `samva journeys rename jrny_7q2xk9mvt4znw8rh --name "Onboarding"` },
  ]),
);

const draft = deriveOverride(
  "draft",
  {
    id: idArgument,
    revision: revisionFlag,
    definition: definitionFlag,
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Validate the definition offline without replacing the draft"),
      Flag.withDefault(false),
    ),
    json: jsonFlag,
  },
  {
    prepare: ({ id, revision, definition }) =>
      readDefinition(definition).pipe(
        Effect.map(
          (body) =>
            ({ id, revision, definition: body }) as Parameters<typeof Journeys.replaceDraft>[0],
        ),
      ),
    call: (request) => Journeys.replaceDraft(request),
    failure: "Could not replace journey draft",
    preview: {
      data: (request) => ({ dryRun: true, action: "journeys.draft", request }),
      render: (request) =>
        printFields([
          ["Dry run", true],
          ["Journey", request.id],
        ]),
    },
    render: (journey) => printJourney(journey),
  },
).pipe(
  Command.withDescription("Replace a journey's draft definition"),
  Command.withExamples([
    {
      command:
        "samva journeys draft jrny_7q2xk9mvt4znw8rh --revision <revision> --definition @welcome.json --json",
    },
  ]),
);

const publish = deriveOverride(
  "publish",
  { id: idArgument, revision: revisionFlag, json: jsonFlag },
  {
    mapInput: ({ id, revision }) => ({ id, revision }),
    call: (request) => Journeys.publish(request),
    failure: "Could not publish journey",
    render: (journey) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("Journey published.\n");
        yield* printJourney(journey);
      }),
  },
).pipe(
  Command.withDescription("Publish the draft as the next immutable version"),
  Command.withExamples([
    { command: "samva journeys publish jrny_7q2xk9mvt4znw8rh --revision <revision> --json" },
  ]),
);

const pause = deriveOverride(
  "pause",
  { id: idArgument, json: jsonFlag },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => Journeys.pause(request),
    failure: "Could not pause journey",
    render: (journey) => printJourney(journey),
  },
).pipe(
  Command.withDescription(
    "Emergency stop: admit no new contacts and hold active runs before their next step",
  ),
  Command.withExamples([{ command: "samva journeys pause jrny_7q2xk9mvt4znw8rh" }]),
);

const resume = deriveOverride(
  "resume",
  { id: idArgument, json: jsonFlag },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => Journeys.resume(request),
    failure: "Could not resume journey",
    render: (journey) => printJourney(journey),
  },
).pipe(
  Command.withDescription("Resume enrollment and continue the runs a pause held"),
  Command.withExamples([{ command: "samva journeys resume jrny_7q2xk9mvt4znw8rh" }]),
);

const archive = deriveOverride(
  "archive",
  {
    id: idArgument,
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
    json: jsonFlag,
  },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => Journeys.archive(request),
    failure: "Could not archive journey",
    preview: {
      data: (request) => ({ dryRun: true, action: "journeys.archive", id: request.id }),
      render: (request) => Console.log(`[dry-run] Would archive journey ${request.id}.`),
    },
    confirmation: (request) => ({
      message: `Archive and exit every active run of Journey ${request.id}?`,
      nonInteractiveMessage:
        "Journey archive requires --yes in non-interactive mode. Preview with --dry-run.",
    }),
    render: (result) =>
      printFields([
        ["ID", result.id],
        ["Result", "archived"],
      ]),
  },
).pipe(
  Command.withDescription("Archive a journey and exit its active runs"),
  Command.withExamples([
    { command: "samva journeys archive jrny_7q2xk9mvt4znw8rh --dry-run" },
    { command: "samva journeys archive jrny_7q2xk9mvt4znw8rh --yes" },
  ]),
);

const remove = deriveOverride(
  "delete",
  {
    id: idArgument,
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
    json: jsonFlag,
  },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => Journeys.remove(request),
    failure: "Could not delete journey",
    preview: {
      data: (request) => ({ dryRun: true, action: "journeys.delete", id: request.id }),
      render: (request) => Console.log(`[dry-run] Would delete journey ${request.id}.`),
    },
    confirmation: (request) => ({
      message: `Permanently delete Journey ${request.id}?`,
      nonInteractiveMessage:
        "Journey delete requires --yes in non-interactive mode. Preview with --dry-run.",
    }),
    render: (result) =>
      printFields([
        ["ID", result.id],
        ["Result", "deleted"],
      ]),
  },
).pipe(
  Command.withDescription(
    "Delete a never-published or archived journey with its versions and runs",
  ),
  Command.withExamples([
    { command: "samva journeys delete jrny_7q2xk9mvt4znw8rh --dry-run" },
    { command: "samva journeys delete jrny_7q2xk9mvt4znw8rh --yes" },
  ]),
);

const getVersion = deriveOverride(
  "version",
  {
    id: idArgument,
    version: Argument.Int("version").pipe(Argument.withDescription("Published version number")),
    json: jsonFlag,
  },
  {
    mapInput: ({ id, version }) => ({ id, version: String(version) }),
    call: (request) => Journeys.getVersion(request),
    failure: "Could not fetch journey version",
    render: printJson,
  },
).pipe(
  Command.withDescription("Show one immutable published definition"),
  Command.withExamples([{ command: "samva journeys version jrny_7q2xk9mvt4znw8rh 2 --json" }]),
);

const stats = deriveOverride(
  "stats",
  {
    id: idArgument,
    version: Flag.Int("version").pipe(
      Flag.withDescription("Published version (default: newest)"),
      Flag.optional,
    ),
    json: jsonFlag,
  },
  {
    mapInput: ({ id, version }) => ({ id, version: Option.getOrUndefined(version) }),
    call: (request) => Journeys.stats(request),
    failure: "Could not fetch journey stats",
    render: (data) =>
      Effect.gen(function* () {
        yield* printFields([
          ["Version", data.version],
          ["Active", data.runs.active],
          ["Paused", data.runs.paused],
          ["Exited", data.runs.exited],
          ["Failed", data.runs.failed],
        ]);
        for (const node of data.nodes)
          yield* Console.log(`${node.nodeId}  now ${node.current}  entered ${node.entered}`);
      }),
  },
).pipe(
  Command.withDescription("Count a published version's runs by status and by node"),
  Command.withExamples([{ command: "samva journeys stats jrny_7q2xk9mvt4znw8rh --json" }]),
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

const runList = deriveOverride(
  "list",
  {
    id: idArgument,
    status: Flag.Literals("status", RUN_STATUSES).pipe(
      Flag.withDescription("Filter by run status"),
      Flag.optional,
    ),
    contact: Flag.String("contact").pipe(
      Flag.withDescription("Filter by contact ID"),
      Flag.optional,
    ),
    cursor: cursorFlag,
    limit: limitFlag,
    all: allFlag,
    json: jsonFlag,
  },
  {
    mapInput: ({ id, status, contact, cursor, limit }) => ({
      id,
      status: Option.getOrUndefined(status),
      contactId: Option.getOrUndefined(contact),
      cursor: Option.getOrUndefined(cursor),
      limit: Option.getOrUndefined(limit),
    }),
    call: (request) => Journeys.listRuns(request),
    failure: (error, request) =>
      toCliApiError("Could not list journey runs", error, { cursor: request.cursor ?? null }),
    paginate: {
      withCursor: (request, cursor) => ({ ...request, cursor }),
      start: (request) => request.cursor,
    },
    render: (page) =>
      Effect.gen(function* () {
        if (page.items.length === 0) yield* Console.log("No runs found.");
        for (const run of page.items) {
          yield* printRun(run);
          yield* Console.log("");
        }
        if (page.nextCursor !== null) yield* printFields([["Next cursor", page.nextCursor]]);
      }),
  },
).pipe(
  Command.withDescription("List a journey's runs, newest first"),
  Command.withExamples([
    { command: "samva journeys runs list jrny_7q2xk9mvt4znw8rh --status active --json" },
    { command: "samva journeys runs list jrny_7q2xk9mvt4znw8rh --all --jsonl" },
  ]),
);

const runGet = deriveOverride(
  "get",
  {
    id: idArgument,
    runId: Argument.String("run").pipe(Argument.withDescription("Run ID")),
    json: jsonFlag,
  },
  {
    mapInput: ({ id, runId }) => ({ id, runId }),
    call: (request) => Journeys.getRun(request),
    failure: "Could not fetch journey run",
    render: (run) =>
      Effect.gen(function* () {
        yield* printRun(run);
        yield* printFields([
          ["Trigger event", `${run.trigger.eventName} (${run.trigger.eventId})`],
        ]);
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
      }),
  },
).pipe(
  Command.withDescription("Show one run with every node it entered, in order"),
  Command.withExamples([
    { command: "samva journeys runs get jrny_7q2xk9mvt4znw8rh jrun_7q2xk9mvt4znw8rh --json" },
  ]),
);

const runs = Command.make("runs").pipe(
  Command.withDescription("Read a journey's runs"),
  Command.withSubcommands([runList, runGet]),
);

const recipes = deriveOverride(
  "recipes",
  { json: jsonFlag },
  {
    call: () => IntegrationsCatalog.recipeCatalog(),
    failure: "Could not read Shopify journey recipes",
    render: (catalog) =>
      Effect.gen(function* () {
        for (const recipe of catalog.recipes) {
          yield* printFields([
            ["Recipe", recipe.title],
            ["ID", recipe.id],
            ["Starts on", recipe.trigger],
            ["Stops on", recipe.stopEvent],
            ["Wait", `${recipe.waitDays} days`],
            ["Channels", recipe.channels.join(", ")],
          ]);
        }
        yield* Console.log("Use --json for event schemas, binding paths, and sample data.");
      }),
  },
).pipe(
  Command.withDescription("List Shopify journey recipes and discover their event inputs"),
  Command.withExamples([{ command: "samva journeys recipes --json" }]),
);

const readiness = deriveOverride(
  "readiness",
  {
    channel: Flag.Literals("channel", RecipeReadinessQuery.fields.channel.literals).pipe(
      Flag.withDescription("Channel for the post-delivery check-in (email or whatsapp)"),
    ),
    integrationAccountId: Flag.String("integration-account-id").pipe(
      Flag.withSchema(IntegrationAccountId),
      Flag.withDescription("Shopify connection to check"),
      Flag.optional,
    ),
    publicationId: Flag.String("publication-id").pipe(
      Flag.withSchema(TemplatePublicationId),
      Flag.withDescription("Exact template publication to check"),
      Flag.optional,
    ),
    senderId: Flag.String("sender-id").pipe(
      Flag.withSchema(EmailSenderId),
      Flag.withDescription("Email sender to check instead of the organization default"),
      Flag.optional,
    ),
    whatsappAccountId: Flag.String("whatsapp-account-id").pipe(
      Flag.withSchema(WhatsAppBusinessAccountId),
      Flag.withDescription(
        "WhatsApp business account to check instead of the organization default",
      ),
      Flag.optional,
    ),
    registrationId: Flag.String("registration-id").pipe(
      Flag.withSchema(TemplateRegistrationId),
      Flag.withDescription("Exact WhatsApp template registration to check"),
      Flag.optional,
    ),
    mailboxEndpointId: Flag.String("mailbox-endpoint-id").pipe(
      Flag.withSchema(MailboxEndpointId),
      Flag.withDescription("Mailbox endpoint to check for replies"),
      Flag.optional,
    ),
    json: jsonFlag,
  },
  {
    mapInput: (input) => ({
      channel: input.channel,
      integrationAccountId: Option.getOrUndefined(input.integrationAccountId),
      publicationId: Option.getOrUndefined(input.publicationId),
      senderId: Option.getOrUndefined(input.senderId),
      whatsappAccountId: Option.getOrUndefined(input.whatsappAccountId),
      registrationId: Option.getOrUndefined(input.registrationId),
      mailboxEndpointId: Option.getOrUndefined(input.mailboxEndpointId),
    }),
    call: (request) => IntegrationsCatalog.recipeReadiness(request),
    failure: "Could not check Shopify recipe readiness",
    render: (result) =>
      Effect.gen(function* () {
        yield* printFields([
          ["Ready", result.ready ? "Yes" : "No"],
          ["Channel", result.channel],
          ["Shopify availability", result.availability.shopify ? "Enabled" : "Disabled"],
          ["Shopify connection", result.shopify?.status ?? "Unavailable"],
          ["Shop", result.shopify?.shop],
          ["Journeys availability", result.availability.journeys ? "Enabled" : "Disabled"],
          ["Plan access", result.availability.plan ?? "Requires organization-wide access"],
          ["Publication", result.publication?.id ?? "Unavailable"],
          ...(result.channel === "email"
            ? ([
                ["Email sender", result.email?.status ?? "Unavailable"],
                ["From address", result.email?.address],
                ["Sending domain ID", result.email?.domainId],
              ] as const)
            : ([
                ["WhatsApp availability", result.availability.whatsapp ? "Enabled" : "Disabled"],
                ["WhatsApp account", result.whatsapp?.status ?? "Unavailable"],
                ["Business number", result.whatsapp?.address],
                ["Registration", result.whatsapp?.registration?.status ?? "Unavailable"],
              ] as const)),
          ["Reply route", result.reply?.status ?? "Unavailable"],
          ["Reply address", result.reply?.address],
          ["Reply mailbox ID", result.reply?.mailboxId],
        ]);
        // What the journey cannot supply to the selected publication, with the server's guidance.
        const issues = result.publication?.inputIssues ?? [];
        if (issues.length > 0) {
          yield* Console.log(
            ["", "Publication input issues:", ...issues.map((issue) => `  - ${issue}`)].join("\n"),
          );
        }
      }),
  },
).pipe(
  Command.withDescription("Check live prerequisites for the Shopify post-delivery check-in"),
  Command.withExamples([
    { command: "samva journeys readiness --channel email" },
    { command: "samva journeys readiness --channel whatsapp --json" },
  ]),
);

const recipeDataFlag = Flag.String("data").pipe(
  Flag.withDescription("Request JSON, @file, or - for piped stdin"),
);
const readRecipeData = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, source: string) =>
  readJsonSource("data", source).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(schema, { onExcessProperty: "error", errors: "all" })(value).pipe(
        Effect.mapError(
          (error) =>
            new CliUsageError({
              code: "recipe_data_invalid",
              message: `Invalid recipe --data: ${error.message}`,
            }),
        ),
      ),
    ),
  );

const recipePreview = deriveOverride(
  "recipe-preview",
  { data: recipeDataFlag, json: jsonFlag },
  {
    prepare: ({ data }) => readRecipeData(RecipePreviewPayload, data),
    call: (request) => IntegrationsCatalog.recipePreview(request),
    failure: "Could not render the recipe sample",
    render: (result) =>
      result.channel === "email"
        ? printFields([
            ["Sample", result.fixture],
            ["Subject", result.content.subject],
            ["Text", result.content.text],
          ])
        : printJson(result.content),
  },
).pipe(Command.withDescription("Render an exact publication with a sample order without sending"));

const recipeConnect = deriveOverride(
  "recipe-connect",
  {
    provider: Argument.Literals("provider", ConnectionHandoffProvider.literals),
    data: recipeDataFlag.pipe(Flag.optional),
    json: jsonFlag,
  },
  {
    prepare: ({ provider, data }) =>
      Option.isSome(data)
        ? readRecipeData(ConnectionHandoffQuery, data.value).pipe(
            Effect.map((query) => ({ provider, ...query })),
          )
        : Effect.succeed({ provider }),
    call: (request) => IntegrationsCatalog.recipeConnectionHandoff(request),
    failure: "Could not prepare the connection handoff",
    render: (result) => Console.log(result.url),
  },
).pipe(
  Command.withDescription("Get the organization dashboard link for Shopify or WhatsApp connection"),
);

const recipeTestHandoff = deriveOverride(
  "recipe-test-handoff",
  { data: recipeDataFlag, json: jsonFlag },
  {
    prepare: ({ data }) => readRecipeData(TestHandoffQuery, data),
    call: (request) => IntegrationsCatalog.recipeTestHandoff(request),
    failure: "Could not prepare the owner test handoff",
    render: (result) => Console.log(result.url),
  },
).pipe(
  Command.withDescription("Open a verified owner test for the exact selection in the dashboard"),
);

const recipeTest = deriveOverride(
  "recipe-test",
  {
    data: recipeDataFlag,
    yes: Flag.Boolean("yes").pipe(
      Flag.withDescription("Confirm the test send to your verified identity"),
    ),
    json: jsonFlag,
  },
  {
    prepare: ({ data }) => readRecipeData(RecipeTestPayload, data),
    call: (request) => IntegrationsCatalog.recipeTest(request),
    failure: "Could not run the owner test",
    confirmation: (request) => ({
      message: `Send a ${request.channel === "email" ? "sample email" : "sample WhatsApp message"} to your verified owner destination?`,
      nonInteractiveMessage:
        "Confirm the owner test with --yes. Use the same requestId after an uncertain response.",
    }),
    render: (result) => printFields([["Message ID", result.messageId]]),
  },
).pipe(Command.withDescription("Send a sample order to the signed-in owner's verified identity"));

const recipeTestReceipt = deriveOverride(
  "recipe-test-receipt",
  {
    requestId: Argument.String("request-id").pipe(Argument.withSchema(RecipeTestRequestId)),
    json: jsonFlag,
  },
  {
    mapInput: ({ requestId }) => ({ requestId }),
    call: (request) => IntegrationsCatalog.recipeTestReceipt(request),
    failure: "Could not read the owner test receipt",
    render: (result) =>
      result === null
        ? Console.log("No test attempt found for that request ID.")
        : printFields([
            ["Message ID", result.messageId],
            ["Acceptance", result.state],
          ]),
  },
).pipe(Command.withDescription("Reconcile a test by original request ID without sending again"));

const setupId = Argument.String("id").pipe(Argument.withSchema(RecipeSetupId));
const recipeSetupsList = deriveOverride(
  "list",
  { json: jsonFlag },
  {
    call: () => IntegrationsCatalog.recipeSetupsList(),
    failure: "Could not list recipe setups",
    render: (result) =>
      Effect.gen(function* () {
        for (const item of result.items)
          yield* printFields([
            ["ID", item.id],
            ["Revision", item.revision],
            ["Channel", item.references.channel],
          ]);
      }),
  },
).pipe(Command.withDescription("List recent recipe setup selections"));

const recipeSetupGet = deriveOverride(
  "get",
  { id: setupId, json: jsonFlag },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => IntegrationsCatalog.recipeSetupGet(request),
    failure: "Could not read the recipe setup",
    render: printJson,
  },
).pipe(Command.withDescription("Read the references and revision of a saved setup"));

const recipeSetupReplace = deriveOverride(
  "save",
  { id: setupId, data: recipeDataFlag, json: jsonFlag },
  {
    prepare: ({ id, data }) =>
      readRecipeData(ReplaceRecipeSetup, data).pipe(Effect.map((payload) => ({ id, ...payload }))),
    call: (request) => IntegrationsCatalog.recipeSetupReplace(request),
    failure: "Could not save the recipe setup",
    render: printJson,
  },
).pipe(
  Command.withDescription(
    "Save references with a new UUID and null revision or replace the current revision",
  ),
);

const recipeSetupActivate = deriveOverride(
  "activate",
  { id: setupId, data: recipeDataFlag, json: jsonFlag },
  {
    prepare: ({ id, data }) =>
      readRecipeData(ActivateRecipeSetup, data).pipe(Effect.map((payload) => ({ id, ...payload }))),
    call: (request) => IntegrationsCatalog.recipeSetupActivate(request),
    failure: "Could not activate the recipe setup",
    render: (result) =>
      printFields([
        ["Journey", result.journey.id],
        ["Status", result.journey.status],
        ["Published version", result.journey.publishedVersion],
        ["Setup revision", result.setup.revision],
      ]),
  },
).pipe(
  Command.withDescription("Publish the reviewed selection on the setup's journey"),
  Command.withExamples([
    {
      command:
        "samva journeys recipe-setups activate <setup-id> --data @reviewed-selection.json --json",
      description: "Pass the saved revision and reviewed send selection.",
    },
  ]),
);

const recipeSetups = Command.make("recipe-setups").pipe(
  Command.withDescription("Save, read, and activate Shopify recipe selections"),
  Command.withSubcommands([
    recipeSetupsList,
    recipeSetupGet,
    recipeSetupReplace,
    recipeSetupActivate,
  ]),
);

export const journeysCommand = Command.make("journeys").pipe(
  Command.withDescription("Create, publish, pause, and observe event-triggered journeys"),
  Command.withSubcommands([
    recipes,
    readiness,
    recipePreview,
    recipeConnect,
    recipeTestHandoff,
    recipeTest,
    recipeTestReceipt,
    recipeSetups,
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
