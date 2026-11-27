import { JsonObject } from "@samva/core/shared/json";
import {
  WHATSAPP_FLOW_CATEGORY_VALUES,
  WhatsAppFlow,
  WhatsAppFlowEncryptionKey,
  WhatsAppFlowEndpointSettings,
  WhatsAppFlowRegistration,
  WhatsAppFlowVersion,
  WhatsAppFlowSubmissionHandler,
} from "@samva/core/whatsapp/flow";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Templates from "samva/effect/templates";
import * as WhatsAppFlows from "samva/effect/whatsapp-flows";

import { SamvaCliError, toCliApiError } from "../errors";
import { getAuthenticatedJson, getClientProvider, postAuthenticatedJson } from "../lib/client";
import { deriveOverride } from "../lib/derive/curated";
import { jsonFlag, printFields, printJson } from "../lib/output";
import { firstProjectTemplate, gitConfig, runGit } from "./templates/project";

/**
 * `samva whatsapp flows create | list | get | publish | register | registrations | endpoint |
 * encryption-key` — WhatsApp
 * Flows, the multi-screen forms a customer fills in inside WhatsApp.
 *
 * A flow's file is `flows/<handle>.json` in a template project. `publish` records one commit of
 * that file as the flow's next version, and `register` creates that version as a Meta flow and
 * publishes it.
 */

/** Flows as the API wire carries them: dates stay ISO strings. */
const WireFlow = Schema.toEncoded(WhatsAppFlow);
export type WireFlow = typeof WireFlow.Type;
const WireVersion = Schema.toEncoded(WhatsAppFlowVersion);
export type WireFlowVersion = typeof WireVersion.Type;
const WireFlowRegistration = Schema.toEncoded(WhatsAppFlowRegistration);
export type WireFlowRegistration = typeof WireFlowRegistration.Type;
const WireEndpointSettings = Schema.toEncoded(WhatsAppFlowEndpointSettings);
export type WireFlowEndpointSettings = typeof WireEndpointSettings.Type;
const WireEncryptionKey = Schema.toEncoded(WhatsAppFlowEncryptionKey);
export type WireFlowEncryptionKey = typeof WireEncryptionKey.Type;

const flowIdArgument = Argument.String("flow-id").pipe(
  Argument.withDescription("Flow id (waflow_…), from `samva whatsapp flows list`"),
);

/** The flows collection, or one flow's sub-resource. */
export const flowsPath = (
  flowId?: string,
  sub?: "versions" | "registrations" | "endpoint" | "endpoint/rotate-secret",
): string => {
  const base = "/v1/whatsapp/flows";
  if (flowId === undefined) return base;
  const one = `${base}/${encodeURIComponent(flowId)}`;
  return sub === undefined ? one : `${one}/${sub}`;
};

/** The create payload. */
export const createFlowPayload = (
  projectId: string,
  handle: string,
  categories: ReadonlyArray<string>,
) => ({ projectId, handle, categories });

/** The register payload: the business account only when named. */
export const registerFlowPayload = (businessAccountId: string | undefined) =>
  businessAccountId === undefined ? {} : { businessAccountId };

/** The path that rotates a business account's flow encryption key. */
export const ENCRYPTION_KEY_ROTATE_PATH = "/v1/whatsapp/flows/encryption-key/rotate";

/** The set-endpoint payload. */
export const setEndpointPayload = (url: string) => ({ url });

/** The rotate-key payload: the business account only when named. */
export const rotateEncryptionKeyPayload = (businessAccountId: string | undefined) =>
  businessAccountId === undefined ? {} : { businessAccountId };

const FLOW_NEXT: Readonly<Record<string, string>> = {
  ConflictError:
    "A flow handle is unique in the organization; pick another. When recording a version, the workspace moved or the commit is not on the project's default branch: push it and retry. When registering, record a version first with `samva whatsapp flows publish`.",
  ValidationError:
    "Read the reason in the message: the flow file at the commit is not Flow JSON Samva sends, or Meta's validator refused the version. Fix `flows/<handle>.json`, publish it again, then register. If no WhatsApp number is connected, connect one in the dashboard first.",
  WhatsAppChannelError: "Meta could not be reached or refused the request. Retry shortly.",
  CredentialsError:
    "The WhatsApp credentials need attention. Reconnect the business account in the dashboard, then retry.",
  ResourceNotFoundError:
    "Check the ids: `samva whatsapp flows list` shows flows, and `samva templates list` shows template projects.",
};

/** A failed flows call with the recovery step that names the flow cause. */
export const flowError =
  (what: string) =>
  (error: unknown): SamvaCliError => {
    const failure = toCliApiError(`Could not ${what}`, error);
    const next = failure.api === undefined ? undefined : FLOW_NEXT[failure.api.reason];
    return next === undefined || failure.api === undefined
      ? failure
      : new SamvaCliError({
          message: failure.message,
          api: { ...failure.api, next },
          details: failure.details,
        });
  };

/** The labelled lines one version prints in human mode. */
export const flowVersionFields = (
  version: WireFlowVersion,
): ReadonlyArray<readonly [string, unknown]> => [
  ["Version", `v${String(version.number)}`],
  ["Version ID", version.id],
  ["Commit", version.commitSha],
  ["Flow JSON", version.jsonVersion],
  ["Screens", version.screens.join(", ")],
  ["Data exchange", version.dataExchange ? "yes (calls the flow's endpoint)" : "no"],
  ["Recorded", version.createdAt],
];

/** The labelled lines one flow prints in human mode. */
export const flowFields = (flow: WireFlow): ReadonlyArray<readonly [string, unknown]> => [
  ["Flow ID", flow.id],
  ["Handle", flow.handle],
  ["Project", flow.projectId],
  ["File", flow.path],
  ["Categories", flow.categories.join(", ")],
  [
    "Endpoint",
    flow.endpoint === null
      ? "none (set one with `samva whatsapp flows endpoint set`)"
      : `${flow.endpoint.url} (updated ${flow.endpoint.updatedAt})`,
  ],
  [
    "Current version",
    flow.currentVersion === null
      ? "none (record one with `samva whatsapp flows publish`)"
      : `v${String(flow.currentVersion.number)} at ${flow.currentVersion.commitSha}`,
  ],
  ["Created", flow.createdAt],
];

/** The labelled lines one registration prints, then each reason Meta's validator gave. */
export const flowRegistrationFields = (
  registration: WireFlowRegistration,
): ReadonlyArray<readonly [string, unknown]> => [
  ["Registration ID", registration.id],
  ["Flow ID", registration.flowId],
  ["Version", `v${String(registration.versionNumber)}`],
  ["Business account", registration.wabaId],
  ["Meta flow ID", registration.providerFlowId ?? "not created yet"],
  ["Name", registration.name],
  ["Status", registration.status],
  ["Published", registration.publishedAt],
  ["Status changed", registration.statusChangedAt],
  ...registration.endpointAlerts.map(
    (alert) =>
      [
        "Alert",
        `${alert.kind}: ${alert.message}${
          alert.value === null
            ? ""
            : ` (${String(alert.value)}${alert.threshold === null ? "" : ` against ${String(alert.threshold)}`})`
        } since ${alert.activatedAt}`,
      ] as const,
  ),
  ...registration.validationErrors.map(
    (issue) =>
      [
        "Validation",
        `${issue.error}: ${issue.message}${issue.path === undefined ? "" : ` (${issue.path})`}`,
      ] as const,
  ),
];

/** The lines printed after the endpoint is set or its secret rotated. The secret is shown once. */
export const flowEndpointFields = (
  settings: Omit<WireFlowEndpointSettings, "secret">,
): ReadonlyArray<readonly [string, unknown]> => [
  ["Endpoint", settings.url],
  ["Updated", settings.updatedAt],
];

/** The lines printed after an encryption key rotates. */
export const flowEncryptionKeyFields = (
  key: WireFlowEncryptionKey,
): ReadonlyArray<readonly [string, unknown]> => [
  ["Business account", key.wabaId],
  ["Numbers updated", key.phoneNumberIds.join(", ")],
  ["Created", key.createdAt],
];

const unreadable = (what: string) => () =>
  new SamvaCliError({ message: `The API answered with an unreadable ${what}.` });

const decodeFlow = (body: unknown) =>
  Schema.decodeUnknownEffect(WireFlow)(body).pipe(Effect.mapError(unreadable("flow")));

const quiet = <A, E, R>(json: boolean, effect: Effect.Effect<A, E, R>) =>
  json ? Effect.provideService(effect, References.MinimumLogLevel, "None") : effect;

const readFlow = (flowId: string) =>
  getAuthenticatedJson(flowsPath(flowId)).pipe(
    Effect.mapError(flowError("get the flow")),
    Effect.flatMap(decodeFlow),
  );

const list = deriveOverride(
  "list",
  { json: jsonFlag },
  {
    mapInput: () => ({}),
    call: () => WhatsAppFlows.list(),
    failure: flowError("list flows"),
    render: (flows) =>
      Effect.gen(function* () {
        if (flows.data.length === 0) {
          yield* Effect.logInfo(
            "No flows. Create one with `samva whatsapp flows create --project <id> --handle <handle> --category <CATEGORY>`.",
          );
          return;
        }
        for (const flow of flows.data) {
          yield* printFields(flowFields(flow));
          yield* Console.log("");
        }
      }),
  },
).pipe(
  Command.withDescription("List the organization's WhatsApp flows, newest first"),
  Command.withExamples([
    { command: "samva whatsapp flows list", description: "See each flow and its current version" },
  ]),
);

const get = deriveOverride(
  "get",
  { id: flowIdArgument, json: jsonFlag },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => WhatsAppFlows.get(request),
    failure: flowError("get the flow"),
    render: (flow) =>
      Effect.gen(function* () {
        yield* printFields(flowFields(flow));
        if (flow.currentVersion !== null) {
          yield* Console.log("");
          yield* printFields(flowVersionFields(flow.currentVersion));
        }
      }),
  },
).pipe(
  Command.withDescription("Get one flow with its current version"),
  Command.withExamples([
    { command: "samva whatsapp flows get waflow_abc123", description: "Read a flow" },
  ]),
);

const create = deriveOverride(
  "create",
  {
    project: Flag.String("project").pipe(
      Flag.withDescription("Template project (tproj_…) whose flows/<handle>.json holds the flow"),
    ),
    handle: Flag.String("handle").pipe(
      Flag.withDescription(
        "Lowercase kebab-case name, unique in its namespace or at organization level",
      ),
    ),
    category: Flag.Literals("category", WHATSAPP_FLOW_CATEGORY_VALUES).pipe(
      Flag.withDescription(
        `Meta flow category (repeatable): ${WHATSAPP_FLOW_CATEGORY_VALUES.join(", ")}`,
      ),
      Flag.atLeast(1),
    ),
    submissionHandler: Flag.Literals(
      "submission-handler",
      WhatsAppFlowSubmissionHandler.literals,
    ).pipe(Flag.withDescription("Who handles Flow submissions (agent by default)"), Flag.optional),
    json: jsonFlag,
  },
  {
    mapInput: ({ project, handle, category, submissionHandler }) => ({
      projectId: project,
      handle,
      categories: category,
      ...(Option.isSome(submissionHandler) ? { submissionHandler: submissionHandler.value } : {}),
    }),
    call: (request) => WhatsAppFlows.create(request),
    failure: flowError("create the flow"),
    render: (flow) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("Flow created.\n");
        yield* printFields(flowFields(flow));
        yield* Console.log(
          `\nCommit ${flow.path} to the project, push it, then run \`samva whatsapp flows publish ${flow.id}\`.`,
        );
      }),
  },
).pipe(
  Command.withDescription(
    "Create a flow whose versions read flows/<handle>.json in a template project",
  ),
  Command.withExamples([
    {
      command:
        "samva whatsapp flows create --project tproj_abc123 --handle appointment --category APPOINTMENT_BOOKING",
      description: "Create the flow, then commit flows/appointment.json and publish it",
    },
  ]),
);

const readFlowJson = Effect.fn("WhatsAppFlowsCli.readFlowJson")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* fs
    .readFileString(path)
    .pipe(
      Effect.mapError(
        () => new SamvaCliError({ message: `Could not read Flow JSON file ${path}.` }),
      ),
    );
  return yield* Schema.decodeEffect(Schema.fromJsonString(JsonObject))(source).pipe(
    Effect.mapError(() => new SamvaCliError({ message: `Expected a JSON object in ${path}.` })),
  );
});

const committedFlowVersion = Effect.fn("WhatsAppFlowsCli.committedFlowVersion")(function* (
  flow: WireFlow,
  commit: string,
) {
  const status = yield* runGit(["status", "--porcelain"]);
  if (status.length > 0) {
    return yield* new SamvaCliError({
      message: "Commit or discard every local change before publishing.",
    });
  }
  const clonedProject = yield* gitConfig("samva.projectId");
  if (clonedProject !== undefined && clonedProject !== "" && clonedProject !== flow.projectId) {
    return yield* new SamvaCliError({
      message: `This clone is template project ${clonedProject}; flow ${flow.id} reads ${flow.projectId}. Run the command in a clone of that project.`,
    });
  }
  const commitSha = yield* runGit(["rev-parse", `${commit}^{commit}`]);
  yield* runGit(["fetch", "--quiet", "origin"]);
  yield* runGit(["cat-file", "-e", `${commitSha}:${flow.path}`]).pipe(
    Effect.mapError(
      () =>
        new SamvaCliError({
          message: `${flow.path} does not exist at commit ${commitSha}. Commit the flow file first.`,
        }),
    ),
  );
  // The git and workspace endpoints address a template; any one of the project's names it.
  const first = yield* firstProjectTemplate(flow.projectId);
  const client = yield* getClientProvider;
  const [repository, workspace] = yield* Effect.all(
    [
      Templates.getGitRepository({ id: first.id }).pipe(client.provide),
      Templates.openWorkspace({ id: first.id }).pipe(client.provide),
    ],
    { concurrency: 2 },
  ).pipe(Effect.mapError((error) => toCliApiError("Could not open the template project", error)));
  yield* runGit([
    "merge-base",
    "--is-ancestor",
    commitSha,
    `refs/remotes/origin/${repository.defaultBranch}`,
  ]).pipe(
    Effect.mapError(
      () =>
        new SamvaCliError({
          message: `Commit ${commitSha} is not on origin/${repository.defaultBranch}. Push it to the template project's default branch before publishing.`,
        }),
    ),
  );
  return { commitSha, expectedWorkspaceRevision: workspace.workspace.revision };
});

const publish = Command.make("publish", {
  id: flowIdArgument,
  commit: Flag.String("commit").pipe(
    Flag.withDescription("Exact commit or Git revision of the flow file to record"),
    Flag.optional,
  ),
  file: Flag.String("file").pipe(
    Flag.withDescription("Path to a Flow JSON document to commit and record"),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Record a Flow JSON file directly, or record a clean, pushed commit from the project's clone.",
  ),
  Command.withExamples([
    {
      command: "samva whatsapp flows publish waflow_abc123 --file ./survey.json",
      description: "Save the Flow JSON and record its version",
    },
    {
      command: "samva whatsapp flows publish waflow_abc123",
      description: "Record the flow file at the current commit",
    },
  ]),
  Command.withHandler(({ id, commit, file, json }) =>
    quiet(
      json,
      Effect.gen(function* () {
        const flow = yield* readFlow(id);
        if (Option.isSome(file) && Option.isSome(commit)) {
          return yield* new SamvaCliError({ message: "Supply either --file or --commit." });
        }
        const body = Option.isSome(file)
          ? { flowJson: yield* readFlowJson(file.value) }
          : yield* committedFlowVersion(
              flow,
              Option.getOrElse(commit, () => "HEAD"),
            );
        const recorded = yield* postAuthenticatedJson(flowsPath(id, "versions"), {
          body,
        }).pipe(Effect.mapError(flowError("record the flow version")));
        const version = yield* Schema.decodeUnknownEffect(WireVersion)(recorded).pipe(
          Effect.mapError(unreadable("flow version")),
        );
        if (json) return yield* printJson(version);
        yield* Effect.logInfo("Flow version recorded.\n");
        yield* printFields(flowVersionFields(version));
        yield* Console.log(`\nRegister it with Meta: samva whatsapp flows register ${flow.id}`);
      }),
    ),
  ),
);

const register = deriveOverride(
  "register",
  {
    id: flowIdArgument,
    number: Flag.String("number").pipe(
      Flag.withDescription(
        "Samva id (waba_…) of the connected number whose business account the flow registers on; the default number's when omitted",
      ),
      Flag.optional,
    ),
    json: jsonFlag,
  },
  {
    mapInput: ({ id, number }) => ({
      id,
      ...(Option.isSome(number) ? { businessAccountId: number.value } : {}),
    }),
    call: (request) => WhatsAppFlows.register(request),
    failure: flowError("register the flow"),
    render: (registration) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("Flow registered.\n");
        yield* printFields(flowRegistrationFields(registration));
      }),
  },
).pipe(
  Command.withDescription(
    "Create the flow's current version as a Meta flow and publish it. Meta never changes a published flow, so each version registers as its own Meta flow.",
  ),
  Command.withExamples([
    {
      command: "samva whatsapp flows register waflow_abc123",
      description: "Register on the default number's business account",
    },
    {
      command: "samva whatsapp flows register waflow_abc123 --number waba_k9mvt4znw8rh7q2x",
      description: "Register on the business account of a specific connected number",
    },
  ]),
);

const registrations = deriveOverride(
  "registrations",
  { id: flowIdArgument, json: jsonFlag },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => WhatsAppFlows.listRegistrations(request),
    failure: flowError("list flow registrations"),
    render: (page) =>
      Effect.gen(function* () {
        if (page.data.length === 0) {
          yield* Effect.logInfo(
            "No registrations. Register one with `samva whatsapp flows register <flow-id>`.",
          );
          return;
        }
        for (const registration of page.data) {
          yield* printFields(flowRegistrationFields(registration));
          yield* Console.log("");
        }
      }),
  },
).pipe(
  Command.withDescription(
    "List the Meta flows a flow's versions registered as, newest version first, with each status",
  ),
  Command.withExamples([
    {
      command: "samva whatsapp flows registrations waflow_abc123 --json",
      description: "Read each registration's status and Meta's validation findings",
    },
  ]),
);

const secretNotice = (secret: string) =>
  Console.log(
    `\nSigning secret (shown once, store it now): ${secret}\nVerify each request's webhook-signature header with it, as for a webhook delivery.`,
  );

const unwrapEndpoint = (settings: {
  readonly url: string;
  readonly updatedAt: string;
  readonly secret?: Redacted.Redacted<string> | undefined;
}): WireFlowEndpointSettings => ({
  url: settings.url,
  updatedAt: settings.updatedAt,
  ...(settings.secret === undefined ? {} : { secret: Redacted.value(settings.secret) }),
});

const printEndpoint = (settings: WireFlowEndpointSettings) =>
  Effect.gen(function* () {
    const { secret, ...shown } = settings;
    yield* printFields(flowEndpointFields(shown));
    if (secret !== undefined) yield* secretNotice(secret);
  });

const endpointSet = deriveOverride(
  "set",
  {
    id: flowIdArgument,
    url: Flag.String("url").pipe(
      Flag.withDescription("HTTPS URL Samva forwards the flow's data-exchange requests to"),
    ),
    json: jsonFlag,
  },
  {
    mapInput: ({ id, url }) => ({ id, url }),
    call: (request) => WhatsAppFlows.setEndpoint(request),
    failure: flowError("set the flow endpoint"),
    mapOutput: (settings) => unwrapEndpoint(settings),
    render: (settings) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("Flow endpoint set.\n");
        yield* printEndpoint(unwrapEndpoint(settings));
      }),
  },
).pipe(
  Command.withDescription(
    "Set the HTTPS endpoint a data-exchange flow calls. Samva signs each request like a webhook delivery. The flow's first endpoint is issued a signing secret, printed once; changing the URL keeps the secret.",
  ),
  Command.withExamples([
    {
      command: "samva whatsapp flows endpoint set waflow_abc123 --url https://example.com/flows",
      description: "Point the flow at your endpoint and capture the signing secret",
    },
  ]),
);

const endpointRotateSecret = deriveOverride(
  "rotate-secret",
  {
    id: flowIdArgument,
    json: jsonFlag,
  },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => WhatsAppFlows.rotateEndpointSecret(request),
    failure: flowError("rotate the endpoint secret"),
    mapOutput: (settings) => unwrapEndpoint(settings),
    render: (settings) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("Endpoint secret rotated.\n");
        yield* printEndpoint(unwrapEndpoint(settings));
      }),
  },
).pipe(
  Command.withDescription(
    "Issue a new signing secret for the flow's endpoint, printed once. The old secret keeps working for 24 hours so you can deploy the new one.",
  ),
  Command.withExamples([
    {
      command: "samva whatsapp flows endpoint rotate-secret waflow_abc123",
      description: "Rotate the secret, then deploy it to your endpoint within a day",
    },
  ]),
);

const endpoint = Command.make("endpoint").pipe(
  Command.withDescription("Manage the HTTPS endpoint a data-exchange flow calls"),
  Command.withSubcommands([endpointSet, endpointRotateSecret]),
);

const encryptionKeyRotate = deriveOverride(
  "rotate",
  {
    number: Flag.String("number").pipe(
      Flag.withDescription(
        "Samva id (waba_…) of the connected number whose business account rotates; the default number's when omitted",
      ),
      Flag.optional,
    ),
    json: jsonFlag,
  },
  {
    mapInput: ({ number }) => ({
      ...(Option.isSome(number) ? { businessAccountId: number.value } : {}),
    }),
    call: (request) => WhatsAppFlows.rotateEncryptionKey(request),
    failure: flowError("rotate the flow encryption key"),
    render: (key) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("Flow encryption key rotated.\n");
        yield* printFields(flowEncryptionKeyFields(key));
      }),
  },
).pipe(
  Command.withDescription(
    "Replace the key Meta encrypts a business account's flow requests with. Samva holds the private half and uploads the public key to each of the account's numbers; the retired key keeps working for 24 hours.",
  ),
  Command.withExamples([
    {
      command: "samva whatsapp flows encryption-key rotate",
      description: "Rotate the default number's business account key",
    },
    {
      command: "samva whatsapp flows encryption-key rotate --number waba_k9mvt4znw8rh7q2x --json",
      description: "Rotate a specific business account's key and read the result as JSON",
    },
  ]),
);

const encryptionKey = Command.make("encryption-key").pipe(
  Command.withDescription("Manage the key Meta encrypts a business account's flow requests with"),
  Command.withSubcommands([encryptionKeyRotate]),
);

export const flows = Command.make("flows").pipe(
  Command.withDescription("Manage WhatsApp flows authored in template projects"),
  Command.withSubcommands([
    list,
    get,
    create,
    publish,
    register,
    registrations,
    endpoint,
    encryptionKey,
  ]),
);
