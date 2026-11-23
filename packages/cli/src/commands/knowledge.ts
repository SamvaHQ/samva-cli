import { KnowledgeSourceList } from "@samva/contracts/knowledge/group";
import {
  KnowledgeSource,
  KnowledgeSourceName,
  KnowledgeWebsiteUrl,
} from "@samva/core/knowledge/source";
import { KnowledgeSourceId, MediaId } from "@samva/core/shared/base";
import { Effect, Option, Schema } from "effect";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";

import { SamvaCliError } from "../errors";
import { getAuthenticatedJson, postAuthenticatedJson } from "../lib/client";
import { connectOperation, deriveOverride } from "../lib/derive/curated";
import { namespaceField, namespaceFlag } from "../lib/namespace";
import { jsonFlag, objectRows, printFields } from "../lib/output";

const decodeSource = Schema.decodeUnknownEffect(KnowledgeSource);
const invalidResponse = (cause: unknown) =>
  new SamvaCliError({ message: `Invalid knowledge response: ${String(cause)}` });
const nameFlag = Flag.String("name").pipe(Flag.withSchema(KnowledgeSourceName), Flag.optional);
const sourceIdArgument = Argument.String("id").pipe(Argument.withSchema(KnowledgeSourceId));
const createFlags = {
  namespace: namespaceFlag("create"),
  name: nameFlag,
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  json: jsonFlag,
};

const connectKnowledgeList = connectOperation((request: { namespaceId?: string }) =>
  Effect.gen(function* () {
    const query =
      request.namespaceId === undefined
        ? ""
        : `?${new URLSearchParams({ namespaceId: request.namespaceId })}`;
    const body = yield* getAuthenticatedJson(`/v1/knowledge/sources${query}`);
    return yield* Schema.decodeUnknownEffect(KnowledgeSourceList)(body).pipe(
      Effect.mapError(invalidResponse),
    );
  }),
);

const connectKnowledgeSource = connectOperation((request: { id: string }) =>
  Effect.gen(function* () {
    const body = yield* getAuthenticatedJson(`/v1/knowledge/sources/${request.id}`);
    return yield* decodeSource(body).pipe(Effect.mapError(invalidResponse));
  }),
);

const connectKnowledgeWebsite = connectOperation(
  (request: { namespaceId?: string; name: string | undefined; url: string }) =>
    Effect.gen(function* () {
      const body = yield* postAuthenticatedJson("/v1/knowledge/sources/websites", {
        body: request,
      });
      return yield* decodeSource(body).pipe(Effect.mapError(invalidResponse));
    }),
);

const connectKnowledgeFile = connectOperation(
  (request: { namespaceId?: string; name: string | undefined; mediaId: string }) =>
    Effect.gen(function* () {
      const body = yield* postAuthenticatedJson("/v1/knowledge/sources/files", {
        body: request,
      });
      return yield* decodeSource(body).pipe(Effect.mapError(invalidResponse));
    }),
);

const connectKnowledgeSync = connectOperation((request: { id: string }) =>
  Effect.gen(function* () {
    const body = yield* postAuthenticatedJson(`/v1/knowledge/sources/${request.id}/sync`, {
      body: {},
    });
    return yield* decodeSource(body).pipe(Effect.mapError(invalidResponse));
  }),
);

const listFlags = { namespace: namespaceFlag("list"), json: jsonFlag };
const list = deriveOverride<
  "list",
  typeof listFlags,
  { namespaceId?: string },
  Schema.Schema.Type<typeof KnowledgeSourceList>,
  unknown
>("list", listFlags, {
  mapInput: ({ namespace }): { namespaceId?: string } => namespaceField(namespace),
  connect: connectKnowledgeList,
  render: (data) =>
    Effect.gen(function* () {
      if (data.items.length === 0) yield* Console.log("No knowledge sources.");
      for (const source of data.items) yield* printFields(objectRows(source));
    }),
}).pipe(
  Command.withDescription("List knowledge sources reachable by this credential"),
  Command.withExamples([{ command: "samva knowledge list --namespace ns_abc123 --json" }]),
);

const getFlags = { id: sourceIdArgument, json: jsonFlag };
const get = deriveOverride<
  "get",
  typeof getFlags,
  { id: string },
  Schema.Schema.Type<typeof KnowledgeSource>,
  unknown
>("get", getFlags, {
  mapInput: ({ id }) => ({ id }),
  connect: connectKnowledgeSource,
  render: (data) => printFields(objectRows(data)),
}).pipe(
  Command.withDescription("Read one knowledge source within the caller's scope"),
  Command.withExamples([{ command: "samva knowledge get ksrc_abc123 --json" }]),
);

const addWebsiteFlags = {
  ...createFlags,
  url: Flag.String("url").pipe(Flag.withSchema(KnowledgeWebsiteUrl)),
};
const addWebsite = deriveOverride<
  "add-website",
  typeof addWebsiteFlags,
  { namespaceId?: string; name: string | undefined; url: string },
  Schema.Schema.Type<typeof KnowledgeSource>,
  unknown
>("add-website", addWebsiteFlags, {
  mapInput: ({ namespace, name, url }) => ({
    ...namespaceField(namespace),
    name: Option.getOrUndefined(name),
    url,
  }),
  connect: connectKnowledgeWebsite,
  preview: {
    data: (request) => ({ dryRun: true, request }),
    render: (request) => printFields(objectRows(request, { explicit: true })),
  },
  render: (data) => printFields(objectRows(data)),
}).pipe(
  Command.withDescription("Add a website for agents in the same namespace to search"),
  Command.withExamples([
    {
      command:
        "samva knowledge add-website --url https://example.com --namespace ns_abc123 --dry-run",
    },
  ]),
);

const addFileFlags = {
  ...createFlags,
  mediaId: Flag.String("media-id").pipe(
    Flag.withSchema(MediaId),
    Flag.withDescription("A ready attachment upload containing the file"),
  ),
};
const addFile = deriveOverride<
  "add-file",
  typeof addFileFlags,
  { namespaceId?: string; name: string | undefined; mediaId: string },
  Schema.Schema.Type<typeof KnowledgeSource>,
  unknown
>("add-file", addFileFlags, {
  mapInput: ({ namespace, name, mediaId }) => ({
    ...namespaceField(namespace),
    name: Option.getOrUndefined(name),
    mediaId,
  }),
  connect: connectKnowledgeFile,
  preview: {
    data: (request) => ({ dryRun: true, request }),
    render: (request) => printFields(objectRows(request, { explicit: true })),
  },
  render: (data) => printFields(objectRows(data)),
}).pipe(
  Command.withDescription("Add an uploaded file for agents in the same namespace to search"),
  Command.withExamples([
    { command: "samva knowledge add-file --media-id media_abc123 --namespace ns_abc123 --dry-run" },
  ]),
);

const syncFlags = {
  id: sourceIdArgument,
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  json: jsonFlag,
};
const sync = deriveOverride<
  "sync",
  typeof syncFlags,
  { id: string },
  Schema.Schema.Type<typeof KnowledgeSource>,
  unknown
>("sync", syncFlags, {
  mapInput: ({ id }) => ({ id }),
  connect: connectKnowledgeSync,
  preview: {
    data: (request) => ({ dryRun: true, action: "knowledge.sync", id: request.id }),
    render: (request) => Console.log(`[dry-run] Would refresh knowledge source ${request.id}.`),
  },
  render: (data) => printFields(objectRows(data)),
}).pipe(
  Command.withDescription("Refresh a knowledge source within the caller's scope"),
  Command.withExamples([{ command: "samva knowledge sync ksrc_abc123 --dry-run" }]),
);

export const knowledgeCommand = Command.make("knowledge").pipe(
  Command.withDescription("Manage knowledge sources; an agent uses sources in its own namespace"),
  Command.withSubcommands([list, get, addWebsite, addFile, sync]),
);
