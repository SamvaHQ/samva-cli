import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Namespaces from "samva/effect/namespaces";

import { CliUsageError, toCliApiError } from "../errors";
import { getClientProvider } from "../lib/client";
import { confirmDestructive } from "../lib/confirm";
import { jsonFlag, printFields, printJson, printJsonLine } from "../lib/output";
import { isJsonLinesRequested } from "../lib/runtime";

const idArgument = Argument.String("id").pipe(Argument.withDescription("Namespace id (ns_...)"));
const optionalString = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.optional);
const dryRunFlag = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Print the planned change without calling the API"),
  Flag.withDefault(false),
);

/** The resource kinds a namespace holds on the public surface, one flag each. */
const RESOURCE_FLAGS = ["domain", "sender", "contact", "template"] as const;
type ResourceKind = (typeof RESOURCE_FLAGS)[number];

const resourceFlags = {
  domain: optionalString("domain", "Domain id (dom_...)"),
  sender: optionalString("sender", "Sender id"),
  contact: optionalString("contact", "Contact id"),
  template: optionalString("template", "Template id; its whole project moves with it"),
};

/** Exactly one of `--domain|--sender|--contact|--template`, as `{ type, id }`. */
const chosenResource = (flags: Record<ResourceKind, Option.Option<string>>) => {
  const chosen = RESOURCE_FLAGS.flatMap((type) => {
    const id = flags[type];
    return Option.isSome(id) ? [{ type, id: id.value }] : [];
  });
  if (chosen.length !== 1) {
    return new CliUsageError({
      code: "resource_flag_required",
      message: `Pass exactly one resource: ${RESOURCE_FLAGS.map((type) => `--${type} <id>`).join(", ")}.`,
    });
  }
  return chosen[0]!;
};

/** Parse `key=value` pairs; the first `=` separates the key, so a value may contain `=`. */
const parsePairs = (flag: string, raw: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const metadata: Record<string, string> = {};
    for (const pair of raw) {
      const at = pair.indexOf("=");
      if (at <= 0) {
        return yield* new CliUsageError({
          code: "invalid_metadata",
          message: `${flag} must be key=value, got "${pair}".`,
        });
      }
      metadata[pair.slice(0, at)] = pair.slice(at + 1);
    }
    return metadata;
  });

const metadataRows = (metadata: Readonly<Record<string, string>>) =>
  Object.entries(metadata).map(([key, value]) => [`Metadata ${key}`, value] as const);

const list = Command.make("list", {
  cursor: optionalString("cursor", "Resume after this nextCursor from a previous page"),
  limit: Flag.Int("limit").pipe(Flag.withDescription("Items per page"), Flag.optional),
  after: optionalString("after", "Only namespaces created after this ISO 8601 instant"),
  before: optionalString("before", "Only namespaces created before this ISO 8601 instant"),
  all: Flag.Boolean("all").pipe(
    Flag.withDescription("Traverse every page (requires --jsonl)"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List namespaces, newest first"),
  Command.withExamples([
    { command: "samva namespaces list" },
    { command: "samva namespaces list --all --jsonl", description: "Stream every page as JSONL" },
  ]),
  Command.withHandler(({ cursor, limit, after, before, all, json }) =>
    Effect.gen(function* () {
      if (all && !isJsonLinesRequested())
        return yield* new CliUsageError({
          code: "all_requires_jsonl",
          message: "--all is an unbounded traversal and requires --jsonl.",
        });
      const client = yield* getClientProvider;
      const query = {
        limit: Option.getOrUndefined(limit),
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
      };
      const page = (pageCursor: string | undefined) =>
        Namespaces.list({ ...query, cursor: pageCursor }).pipe(
          client.provide,
          Effect.mapError((error) =>
            toCliApiError("Could not list namespaces", error, { cursor: pageCursor ?? null }),
          ),
        );
      let nextCursor = Option.getOrUndefined(cursor);
      for (;;) {
        const data = yield* page(nextCursor);
        if (isJsonLinesRequested()) {
          for (const item of data.items) yield* printJsonLine(item);
        } else if (json) {
          return yield* printJson(data);
        } else {
          if (data.items.length === 0) {
            return yield* Console.log(
              `No namespaces yet. Create one with \`samva namespaces create "Acme"\`.`,
            );
          }
          for (const item of data.items) {
            yield* printFields([
              ["ID", item.id],
              ["Name", item.name],
              ["Created", item.createdAt],
            ]);
            yield* Console.log("");
          }
          if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
        }
        if (!all || data.nextCursor === null) return;
        nextCursor = data.nextCursor;
      }
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const create = Command.make("create", {
  name: Argument.String("name").pipe(Argument.withDescription("Namespace name")),
  metadata: Flag.String("metadata").pipe(
    Flag.withDescription("Your own label, key=value (repeatable); Samva stores and never reads it"),
    Flag.atLeast(0),
  ),
  dryRun: dryRunFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create a namespace, a sub-tenant for one of your customers"),
  Command.withExamples([
    { command: "samva namespaces create Acme --metadata customerId=cus_123" },
    { command: "samva namespaces create Acme --dry-run --json" },
  ]),
  Command.withHandler(({ name, metadata, dryRun, json }) =>
    Effect.gen(function* () {
      const labels = yield* parsePairs("--metadata", metadata);
      const request = { name, ...(metadata.length === 0 ? {} : { metadata: labels }) };
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "namespaces.create", request })
          : printFields([["Action", "namespaces.create"], ["Name", name], ...metadataRows(labels)]);
      const client = yield* getClientProvider;
      const created = yield* Namespaces.create(request).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not create namespace", error)),
      );
      if (json) return yield* printJson(created);
      yield* printFields([
        ["ID", created.id],
        ["Name", created.name],
        ...metadataRows(created.metadata),
        ["Created", created.createdAt],
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const get = Command.make("get", { id: idArgument, json: jsonFlag }).pipe(
  Command.withDescription("Get a namespace and its metadata"),
  Command.withExamples([{ command: "samva namespaces get ns_7q2xk9mvt4znw8rh --json" }]),
  Command.withHandler(({ id, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const namespace = yield* Namespaces.get({ id }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not get namespace", error)),
      );
      if (json) return yield* printJson(namespace);
      yield* printFields([
        ["ID", namespace.id],
        ["Name", namespace.name],
        ...metadataRows(namespace.metadata),
        ["Created", namespace.createdAt],
        ["Updated", namespace.updatedAt],
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const update = Command.make("update", {
  id: idArgument,
  name: optionalString("name", "New name"),
  metadata: Flag.String("metadata").pipe(
    Flag.withDescription("Set a metadata label, key=value (repeatable); other keys are kept"),
    Flag.atLeast(0),
  ),
  unsetMetadata: Flag.String("unset-metadata").pipe(
    Flag.withDescription("Delete a metadata key (repeatable)"),
    Flag.atLeast(0),
  ),
  dryRun: dryRunFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Rename a namespace or change its metadata"),
  Command.withExamples([
    { command: "samva namespaces update ns_7q2xk9mvt4znw8rh --name Acme --metadata plan=pro" },
    { command: "samva namespaces update ns_7q2xk9mvt4znw8rh --unset-metadata plan" },
  ]),
  Command.withHandler(({ id, name, metadata, unsetMetadata, dryRun, json }) =>
    Effect.gen(function* () {
      const labels = yield* parsePairs("--metadata", metadata);
      const conflicting = unsetMetadata.filter((key) => key in labels);
      if (conflicting.length > 0) {
        return yield* new CliUsageError({
          code: "metadata_conflict",
          message: `--metadata and --unset-metadata both name ${conflicting.join(", ")}.`,
        });
      }
      if (Option.isNone(name) && metadata.length === 0 && unsetMetadata.length === 0) {
        return yield* new CliUsageError({
          code: "nothing_to_update",
          message: "Pass --name, --metadata key=value, or --unset-metadata key.",
        });
      }
      // The API merges metadata by key and deletes a key set to null.
      const merged = {
        ...labels,
        ...Object.fromEntries(unsetMetadata.map((key) => [key, null] as const)),
      };
      const request = {
        ...Option.match(name, { onNone: () => ({}), onSome: (value) => ({ name: value }) }),
        ...(metadata.length === 0 && unsetMetadata.length === 0 ? {} : { metadata: merged }),
      };
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "namespaces.update", id, request })
          : printFields([
              ["Action", "namespaces.update"],
              ["Namespace", id],
              ["Name", Option.getOrUndefined(name)],
              ...metadataRows(labels),
              ...unsetMetadata.map((key) => [`Unset ${key}`, "yes"] as const),
            ]);
      const client = yield* getClientProvider;
      const updated = yield* Namespaces.update({ id, ...request }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not update namespace", error)),
      );
      if (json) return yield* printJson(updated);
      yield* printFields([
        ["ID", updated.id],
        ["Name", updated.name],
        ...metadataRows(updated.metadata),
        ["Updated", updated.updatedAt],
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const remove = Command.make("delete", {
  id: idArgument,
  dryRun: dryRunFlag,
  yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Delete an empty namespace; one that still holds anything is refused with a count of what remains",
  ),
  Command.withExamples([
    { command: "samva namespaces delete ns_7q2xk9mvt4znw8rh --dry-run" },
    { command: "samva namespaces delete ns_7q2xk9mvt4znw8rh --yes" },
  ]),
  Command.withHandler(({ id, dryRun, yes, json }) =>
    Effect.gen(function* () {
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "namespaces.delete", id })
          : Console.log(`[dry-run] Would delete namespace ${id}.`);
      yield* confirmDestructive({
        yes,
        json,
        message: `Delete namespace ${id}?`,
        nonInteractiveMessage:
          "Namespace deletion requires --yes in non-interactive mode. Preview with --dry-run.",
      });
      const client = yield* getClientProvider;
      const result = yield* Namespaces.remove({ id }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not delete namespace", error)),
      );
      if (json) return yield* printJson(result);
      yield* Console.log(`Deleted namespace ${id}.`);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const assign = Command.make("assign", {
  id: idArgument,
  ...resourceFlags,
  dryRun: dryRunFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Move a domain, sender, contact, or template into a namespace; pass exactly one resource flag",
  ),
  Command.withExamples([
    { command: "samva namespaces assign ns_7q2xk9mvt4znw8rh --domain dom_xyz789" },
    {
      command:
        "samva namespaces assign ns_7q2xk9mvt4znw8rh --contact contact_7q2xk9mvt4znw8rh --dry-run",
    },
  ]),
  Command.withHandler(({ id, domain, sender, contact, template, dryRun, json }) =>
    Effect.gen(function* () {
      const resource = chosenResource({ domain, sender, contact, template });
      if (resource instanceof CliUsageError) return yield* resource;
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "namespaces.assign", id, request: resource })
          : Console.log(`[dry-run] Would move ${resource.type} ${resource.id} into ${id}.`);
      const client = yield* getClientProvider;
      const moved = yield* Namespaces.assignResource({
        id,
        type: resource.type,
        resourceId: resource.id,
      }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not assign resource", error)),
      );
      if (json) return yield* printJson(moved);
      yield* printFields([
        ["Type", moved.type],
        ["ID", moved.id],
        ["Namespace", moved.namespaceId],
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const unassign = Command.make("unassign", {
  id: idArgument,
  ...resourceFlags,
  dryRun: dryRunFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Return a domain, sender, contact, or template to organization level; pass exactly one resource flag",
  ),
  Command.withExamples([
    { command: "samva namespaces unassign ns_7q2xk9mvt4znw8rh --domain dom_xyz789" },
  ]),
  Command.withHandler(({ id, domain, sender, contact, template, dryRun, json }) =>
    Effect.gen(function* () {
      const resource = chosenResource({ domain, sender, contact, template });
      if (resource instanceof CliUsageError) return yield* resource;
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "namespaces.unassign", id, request: resource })
          : Console.log(
              `[dry-run] Would return ${resource.type} ${resource.id} from ${id} to organization level.`,
            );
      const client = yield* getClientProvider;
      const moved = yield* Namespaces.removeResource({
        id,
        type: resource.type,
        resourceId: resource.id,
      }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not unassign resource", error)),
      );
      if (json) return yield* printJson(moved);
      yield* printFields([
        ["Type", moved.type],
        ["ID", moved.id],
        ["Namespace", moved.namespaceId ?? "organization"],
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const usage = Command.make("usage", {
  id: idArgument,
  after: optionalString("after", "Start of the window, an ISO 8601 instant"),
  before: optionalString("before", "End of the window, an ISO 8601 instant"),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Count the messages a namespace sent and received in a window"),
  Command.withExamples([
    { command: "samva namespaces usage ns_7q2xk9mvt4znw8rh --after 2026-10-01T00:00:00Z --json" },
  ]),
  Command.withHandler(({ id, after, before, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Namespaces.getUsage({
        id,
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
      }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not get namespace usage", error)),
      );
      if (json) return yield* printJson(data);
      yield* printFields([
        ["Namespace", data.namespaceId],
        ["Period start", data.periodStart],
        ["Period end", data.periodEnd],
        ["Email", data.emailCount],
        ["Total", data.totalMessages],
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

export const namespacesCommand = Command.make("namespaces").pipe(
  Command.withDescription("Manage namespaces, the sub-tenants of your organization"),
  Command.withExamples([{ command: "samva namespaces list --json" }]),
  Command.withSubcommands([list, create, get, update, remove, assign, unassign, usage]),
);
