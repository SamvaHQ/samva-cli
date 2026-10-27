import {
  WHATSAPP_FLOW_CATEGORY_VALUES,
  WhatsAppFlow,
  WhatsAppFlowEncryptionKey,
  WhatsAppFlowEndpointSettings,
  WhatsAppFlowList,
  WhatsAppFlowRegistration,
  WhatsAppFlowRegistrationList,
  WhatsAppFlowVersion,
} from "@samva/core/whatsapp/flow";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Templates from "samva/effect/templates";

import { SamvaCliError, toCliApiError } from "../errors";
import { getAuthenticatedJson, getClientProvider, postAuthenticatedJson } from "../lib/client";
import { jsonFlag, printFields, printJson } from "../lib/output";
import { gitConfig, listProjectTemplates, runGit } from "./templates/project";

/**
 * `samva whatsapp flows create | list | get | publish | register | registrations | endpoint |
 * encryption-key` — WhatsApp
 * Flows, the multi-screen forms a customer fills in inside WhatsApp.
 *
 * A flow's file is `flows/<handle>.json` in a template project. `publish` records one commit of
 * that file as the flow's next version, and `register` creates that version as a Meta flow and
 * publishes it. The flows API is hidden (served while the `whatsapp` launch flag is on, absent
 * from the public SDK), so the commands call it directly with the CLI's credentials, as the
 * template registration commands do.
 */

/** Flows as the API wire carries them: dates stay ISO strings. */
const WireFlow = Schema.toEncoded(WhatsAppFlow);
export type WireFlow = typeof WireFlow.Type;
const WireFlowList = Schema.toEncoded(WhatsAppFlowList);
const WireVersion = Schema.toEncoded(WhatsAppFlowVersion);
export type WireFlowVersion = typeof WireVersion.Type;
const WireFlowRegistration = Schema.toEncoded(WhatsAppFlowRegistration);
export type WireFlowRegistration = typeof WireFlowRegistration.Type;
const WireFlowRegistrationList = Schema.toEncoded(WhatsAppFlowRegistrationList);
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
  FlagDisabledError: "WhatsApp is not enabled for this organization.",
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

const list = Command.make("list", { json: jsonFlag }).pipe(
  Command.withDescription("List the organization's WhatsApp flows, newest first"),
  Command.withExamples([
    { command: "samva whatsapp flows list", description: "See each flow and its current version" },
  ]),
  Command.withHandler(({ json }) =>
    quiet(
      json,
      Effect.gen(function* () {
        const body = yield* getAuthenticatedJson(flowsPath()).pipe(
          Effect.mapError(flowError("list flows")),
        );
        const flows = yield* Schema.decodeUnknownEffect(WireFlowList)(body).pipe(
          Effect.mapError(unreadable("list")),
        );
        if (json) return yield* printJson(flows);
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
    ),
  ),
);

const get = Command.make("get", { id: flowIdArgument, json: jsonFlag }).pipe(
  Command.withDescription("Get one flow with its current version"),
  Command.withExamples([
    { command: "samva whatsapp flows get waflow_abc123", description: "Read a flow" },
  ]),
  Command.withHandler(({ id, json }) =>
    quiet(
      json,
      Effect.gen(function* () {
        const flow = yield* readFlow(id);
        if (json) return yield* printJson(flow);
        yield* printFields(flowFields(flow));
        if (flow.currentVersion !== null) {
          yield* Console.log("");
          yield* printFields(flowVersionFields(flow.currentVersion));
        }
      }),
    ),
  ),
);

const create = Command.make("create", {
  project: Flag.String("project").pipe(
    Flag.withDescription("Template project (tproj_…) whose flows/<handle>.json holds the flow"),
  ),
  handle: Flag.String("handle").pipe(
    Flag.withDescription("Lowercase kebab-case name, unique in the organization"),
  ),
  category: Flag.Literals("category", WHATSAPP_FLOW_CATEGORY_VALUES).pipe(
    Flag.withDescription(
      `Meta flow category (repeatable): ${WHATSAPP_FLOW_CATEGORY_VALUES.join(", ")}`,
    ),
    Flag.atLeast(1),
  ),
  json: jsonFlag,
}).pipe(
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
  Command.withHandler(({ project, handle, category, json }) =>
    quiet(
      json,
      Effect.gen(function* () {
        const body = yield* postAuthenticatedJson(flowsPath(), {
          body: createFlowPayload(project, handle, category),
        }).pipe(Effect.mapError(flowError("create the flow")));
        const flow = yield* decodeFlow(body);
        if (json) return yield* printJson(flow);
        yield* Effect.logInfo("Flow created.\n");
        yield* printFields(flowFields(flow));
        yield* Console.log(
          `\nCommit ${flow.path} to the project, push it, then run \`samva whatsapp flows publish ${flow.id}\`.`,
        );
      }),
    ),
  ),
);

const publish = Command.make("publish", {
  id: flowIdArgument,
  commit: Flag.String("commit").pipe(
    Flag.withDescription("Exact commit or Git revision of the flow file to record"),
    Flag.withDefault("HEAD"),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Record the flow's file at a clean, pushed commit as its next version. Run it inside a clone of the flow's template project.",
  ),
  Command.withExamples([
    {
      command: "samva whatsapp flows publish waflow_abc123",
      description: "Record the flow file at the current commit",
    },
  ]),
  Command.withHandler(({ id, commit, json }) =>
    quiet(
      json,
      Effect.gen(function* () {
        const flow = yield* readFlow(id);
        const status = yield* runGit(["status", "--porcelain"]);
        if (status.length > 0) {
          return yield* new SamvaCliError({
            message: "Commit or discard every local change before publishing.",
          });
        }
        const clonedProject = yield* gitConfig("samva.projectId");
        if (
          clonedProject !== undefined &&
          clonedProject !== "" &&
          clonedProject !== flow.projectId
        ) {
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
        const templates = yield* listProjectTemplates(flow.projectId);
        const client = yield* getClientProvider;
        const first = templates[0]!;
        const [repository, workspace] = yield* Effect.all(
          [
            Templates.getGitRepository({ id: first.id }).pipe(client.provide),
            Templates.openWorkspace({ id: first.id }).pipe(client.provide),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.mapError((error) => toCliApiError("Could not open the template project", error)),
        );
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
        const recorded = yield* postAuthenticatedJson(flowsPath(id, "versions"), {
          body: { commitSha, expectedWorkspaceRevision: workspace.workspace.revision },
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

const register = Command.make("register", {
  id: flowIdArgument,
  number: Flag.String("number").pipe(
    Flag.withDescription(
      "Samva id (waba_…) of the connected number whose business account the flow registers on; the default number's when omitted",
    ),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
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
  Command.withHandler(({ id, number, json }) =>
    quiet(
      json,
      Effect.gen(function* () {
        const body = yield* postAuthenticatedJson(flowsPath(id, "registrations"), {
          body: registerFlowPayload(Option.getOrUndefined(number)),
        }).pipe(Effect.mapError(flowError("register the flow")));
        const registration = yield* Schema.decodeUnknownEffect(WireFlowRegistration)(body).pipe(
          Effect.mapError(unreadable("registration")),
        );
        if (json) return yield* printJson(registration);
        yield* Effect.logInfo("Flow registered.\n");
        yield* printFields(flowRegistrationFields(registration));
      }),
    ),
  ),
);

const registrations = Command.make("registrations", { id: flowIdArgument, json: jsonFlag }).pipe(
  Command.withDescription(
    "List the Meta flows a flow's versions registered as, newest version first, with each status",
  ),
  Command.withExamples([
    {
      command: "samva whatsapp flows registrations waflow_abc123 --json",
      description: "Read each registration's status and Meta's validation findings",
    },
  ]),
  Command.withHandler(({ id, json }) =>
    quiet(
      json,
      Effect.gen(function* () {
        const body = yield* getAuthenticatedJson(flowsPath(id, "registrations")).pipe(
          Effect.mapError(flowError("list flow registrations")),
        );
        const page = yield* Schema.decodeUnknownEffect(WireFlowRegistrationList)(body).pipe(
          Effect.mapError(unreadable("list")),
        );
        if (json) return yield* printJson(page);
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
    ),
  ),
);

const secretNotice = (secret: string) =>
  Console.log(
    `\nSigning secret (shown once, store it now): ${secret}\nVerify each request's webhook-signature header with it, as for a webhook delivery.`,
  );

const printEndpoint = (settings: WireFlowEndpointSettings, json: boolean) =>
  Effect.gen(function* () {
    if (json) return yield* printJson(settings);
    const { secret, ...shown } = settings;
    yield* printFields(flowEndpointFields(shown));
    if (secret !== undefined) yield* secretNotice(secret);
  });

const decodeEndpoint = (body: unknown) =>
  Schema.decodeUnknownEffect(WireEndpointSettings)(body).pipe(
    Effect.mapError(unreadable("endpoint")),
  );

const endpointSet = Command.make("set", {
  id: flowIdArgument,
  url: Flag.String("url").pipe(
    Flag.withDescription("HTTPS URL Samva forwards the flow's data-exchange requests to"),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Set the HTTPS endpoint a data-exchange flow calls. Samva signs each request like a webhook delivery. The flow's first endpoint is issued a signing secret, printed once; changing the URL keeps the secret.",
  ),
  Command.withExamples([
    {
      command: "samva whatsapp flows endpoint set waflow_abc123 --url https://example.com/flows",
      description: "Point the flow at your endpoint and capture the signing secret",
    },
  ]),
  Command.withHandler(({ id, url, json }) =>
    quiet(
      json,
      Effect.gen(function* () {
        const body = yield* postAuthenticatedJson(flowsPath(id, "endpoint"), {
          method: "PUT",
          body: setEndpointPayload(url),
        }).pipe(Effect.mapError(flowError("set the flow endpoint")));
        const settings = yield* decodeEndpoint(body);
        if (!json) yield* Effect.logInfo("Flow endpoint set.\n");
        yield* printEndpoint(settings, json);
      }),
    ),
  ),
);

const endpointRotateSecret = Command.make("rotate-secret", {
  id: flowIdArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Issue a new signing secret for the flow's endpoint, printed once. The old secret keeps working for 24 hours so you can deploy the new one.",
  ),
  Command.withExamples([
    {
      command: "samva whatsapp flows endpoint rotate-secret waflow_abc123",
      description: "Rotate the secret, then deploy it to your endpoint within a day",
    },
  ]),
  Command.withHandler(({ id, json }) =>
    quiet(
      json,
      Effect.gen(function* () {
        const body = yield* postAuthenticatedJson(flowsPath(id, "endpoint/rotate-secret"), {
          body: {},
        }).pipe(Effect.mapError(flowError("rotate the endpoint secret")));
        const settings = yield* decodeEndpoint(body);
        if (!json) yield* Effect.logInfo("Endpoint secret rotated.\n");
        yield* printEndpoint(settings, json);
      }),
    ),
  ),
);

const endpoint = Command.make("endpoint").pipe(
  Command.withDescription("Manage the HTTPS endpoint a data-exchange flow calls"),
  Command.withSubcommands([endpointSet, endpointRotateSecret]),
);

const encryptionKeyRotate = Command.make("rotate", {
  number: Flag.String("number").pipe(
    Flag.withDescription(
      "Samva id (waba_…) of the connected number whose business account rotates; the default number's when omitted",
    ),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
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
  Command.withHandler(({ number, json }) =>
    quiet(
      json,
      Effect.gen(function* () {
        const body = yield* postAuthenticatedJson(ENCRYPTION_KEY_ROTATE_PATH, {
          body: rotateEncryptionKeyPayload(Option.getOrUndefined(number)),
        }).pipe(Effect.mapError(flowError("rotate the flow encryption key")));
        const key = yield* Schema.decodeUnknownEffect(WireEncryptionKey)(body).pipe(
          Effect.mapError(unreadable("encryption key")),
        );
        if (json) return yield* printJson(key);
        yield* Effect.logInfo("Flow encryption key rotated.\n");
        yield* printFields(flowEncryptionKeyFields(key));
      }),
    ),
  ),
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
