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
import { namespaceField, namespaceFlag } from "../lib/namespace";
import { jsonFlag, objectRows, printFields, printJson } from "../lib/output";

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

const list = Command.make("list", { namespace: namespaceFlag("list"), json: jsonFlag }).pipe(
  Command.withDescription("List knowledge sources reachable by this credential"),
  Command.withExamples([{ command: "samva knowledge list --namespace ns_abc123 --json" }]),
  Command.withHandler(({ namespace, json }) =>
    Effect.gen(function* () {
      const query = Option.isSome(namespace)
        ? `?${new URLSearchParams({ namespaceId: namespace.value })}`
        : "";
      const body = yield* getAuthenticatedJson(`/v1/knowledge/sources${query}`);
      const data = yield* Schema.decodeUnknownEffect(KnowledgeSourceList)(body).pipe(
        Effect.mapError(invalidResponse),
      );
      if (json) return yield* printJson(data);
      if (data.items.length === 0) yield* Console.log("No knowledge sources.");
      for (const source of data.items) yield* printFields(objectRows(source));
    }),
  ),
);

const get = Command.make("get", { id: sourceIdArgument, json: jsonFlag }).pipe(
  Command.withDescription("Read one knowledge source within the caller's scope"),
  Command.withExamples([{ command: "samva knowledge get ksrc_abc123 --json" }]),
  Command.withHandler(({ id, json }) =>
    Effect.gen(function* () {
      const body = yield* getAuthenticatedJson(`/v1/knowledge/sources/${id}`);
      const data = yield* decodeSource(body).pipe(Effect.mapError(invalidResponse));
      if (json) return yield* printJson(data);
      yield* printFields(objectRows(data));
    }),
  ),
);

const addWebsite = Command.make("add-website", {
  ...createFlags,
  url: Flag.String("url").pipe(Flag.withSchema(KnowledgeWebsiteUrl)),
}).pipe(
  Command.withDescription("Add a website for agents in the same namespace to search"),
  Command.withExamples([
    {
      command:
        "samva knowledge add-website --url https://example.com --namespace ns_abc123 --dry-run",
    },
  ]),
  Command.withHandler(({ namespace, name, url, dryRun, json }) =>
    Effect.gen(function* () {
      const payload = { ...namespaceField(namespace), name: Option.getOrUndefined(name), url };
      if (dryRun) {
        return yield* json
          ? printJson({ dryRun: true, request: payload })
          : printFields(objectRows(payload, { explicit: true }));
      }
      const body = yield* postAuthenticatedJson("/v1/knowledge/sources/websites", {
        body: payload,
      });
      const data = yield* decodeSource(body).pipe(Effect.mapError(invalidResponse));
      if (json) return yield* printJson(data);
      yield* printFields(objectRows(data));
    }),
  ),
);

const addFile = Command.make("add-file", {
  ...createFlags,
  mediaId: Flag.String("media-id").pipe(
    Flag.withSchema(MediaId),
    Flag.withDescription("A ready attachment upload containing the file"),
  ),
}).pipe(
  Command.withDescription("Add an uploaded file for agents in the same namespace to search"),
  Command.withExamples([
    { command: "samva knowledge add-file --media-id media_abc123 --namespace ns_abc123 --dry-run" },
  ]),
  Command.withHandler(({ namespace, name, mediaId, dryRun, json }) =>
    Effect.gen(function* () {
      const payload = { ...namespaceField(namespace), name: Option.getOrUndefined(name), mediaId };
      if (dryRun) {
        return yield* json
          ? printJson({ dryRun: true, request: payload })
          : printFields(objectRows(payload, { explicit: true }));
      }
      const body = yield* postAuthenticatedJson("/v1/knowledge/sources/files", { body: payload });
      const data = yield* decodeSource(body).pipe(Effect.mapError(invalidResponse));
      if (json) return yield* printJson(data);
      yield* printFields(objectRows(data));
    }),
  ),
);

const sync = Command.make("sync", {
  id: sourceIdArgument,
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Refresh a knowledge source within the caller's scope"),
  Command.withExamples([{ command: "samva knowledge sync ksrc_abc123 --dry-run" }]),
  Command.withHandler(({ id, dryRun, json }) =>
    Effect.gen(function* () {
      if (dryRun) {
        return yield* json
          ? printJson({ dryRun: true, action: "knowledge.sync", id })
          : Console.log(`[dry-run] Would refresh knowledge source ${id}.`);
      }
      const body = yield* postAuthenticatedJson(`/v1/knowledge/sources/${id}/sync`, { body: {} });
      const data = yield* decodeSource(body).pipe(Effect.mapError(invalidResponse));
      if (json) return yield* printJson(data);
      yield* printFields(objectRows(data));
    }),
  ),
);

export const knowledgeCommand = Command.make("knowledge").pipe(
  Command.withDescription("Manage knowledge sources; an agent uses sources in its own namespace"),
  Command.withSubcommands([list, get, addWebsite, addFile, sync]),
);
