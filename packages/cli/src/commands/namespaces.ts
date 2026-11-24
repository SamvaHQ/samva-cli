import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Namespaces from "samva/effect/namespaces";

import { CliUsageError, toCliApiError } from "../errors";
import { yesFlag } from "../lib/confirm";
import { deriveOverride } from "../lib/derive/curated";
import { jsonFlag, printFields } from "../lib/output";
import { namespacePortalLinks } from "./namespace-portal-links";

const idArgument = Argument.String("id").pipe(Argument.withDescription("Namespace id (ns_...)"));
const optionalString = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.optional);
const dryRunFlag = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Print the planned change without calling the API"),
  Flag.withDefault(false),
);

/** The resource kinds a namespace holds on the public surface, one flag each. */
const RESOURCE_FLAGS = [
  "domain",
  "sender",
  "contact",
  "template",
  "whatsappNumber",
  "smsNumber",
] as const;
type ResourceKind = (typeof RESOURCE_FLAGS)[number];

const resourceFlags = {
  domain: optionalString("domain", "Domain id (dom_...)"),
  sender: optionalString("sender", "Sender id"),
  contact: optionalString("contact", "Contact id"),
  whatsappNumber: optionalString(
    "whatsapp-number",
    "WhatsApp number id (requires WhatsApp access)",
  ),
  smsNumber: optionalString("sms-number", "SMS number id (requires SMS access)"),
  template: optionalString("template", "Template id; its whole project moves with it"),
};

/** Exactly one resource flag, as `{ type, id }`. */
const chosenResource = (flags: Record<ResourceKind, Option.Option<string>>) => {
  const chosen = RESOURCE_FLAGS.flatMap((type) => {
    const id = flags[type];
    return Option.isSome(id) ? [{ type, id: id.value }] : [];
  });
  const [only, ...rest] = chosen;
  if (only === undefined || rest.length > 0) {
    return new CliUsageError({
      code: "resource_flag_required",
      message: `Pass exactly one resource: ${RESOURCE_FLAGS.map((type) => `--${type === "whatsappNumber" ? "whatsapp-number" : type === "smsNumber" ? "sms-number" : type} <id>`).join(", ")}.`,
    });
  }
  return only;
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

const list = deriveOverride(
  "list",
  {
    cursor: optionalString("cursor", "Resume after this nextCursor from a previous page"),
    limit: Flag.Int("limit").pipe(Flag.withDescription("Items per page"), Flag.optional),
    after: optionalString("after", "Only namespaces created after this ISO 8601 instant"),
    before: optionalString("before", "Only namespaces created before this ISO 8601 instant"),
    all: Flag.Boolean("all").pipe(
      Flag.withDescription("Traverse every page (requires --jsonl)"),
      Flag.withDefault(false),
    ),
    json: jsonFlag,
  },
  {
    mapInput: ({ cursor, limit, after, before }) => ({
      limit: Option.getOrUndefined(limit),
      after: Option.getOrUndefined(after),
      before: Option.getOrUndefined(before),
      cursor: Option.getOrUndefined(cursor),
    }),
    call: (request) => Namespaces.list(request),
    failure: (error, request) =>
      toCliApiError("Could not list namespaces", error, { cursor: request.cursor ?? null }),
    paginate: {
      withCursor: (request, cursor) => ({ ...request, cursor }),
      start: (request) => request.cursor,
    },
    render: (data) =>
      Effect.gen(function* () {
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
      }),
  },
).pipe(
  Command.withDescription("List namespaces, newest first"),
  Command.withExamples([
    { command: "samva namespaces list" },
    { command: "samva namespaces list --all --jsonl", description: "Stream every page as JSONL" },
  ]),
);

const create = deriveOverride(
  "create",
  {
    name: Argument.String("name").pipe(Argument.withDescription("Namespace name")),
    metadata: Flag.String("metadata").pipe(
      Flag.withDescription(
        "Your own label, key=value (repeatable); Samva stores and never reads it",
      ),
      Flag.atLeast(0),
    ),
    dryRun: dryRunFlag,
    json: jsonFlag,
  },
  {
    prepare: ({ name, metadata }) =>
      Effect.gen(function* () {
        const labels = yield* parsePairs("--metadata", metadata);
        return { name, ...(metadata.length === 0 ? {} : { metadata: labels }) };
      }),
    call: (request) => Namespaces.create(request),
    failure: "Could not create namespace",
    preview: {
      data: (request) => ({ dryRun: true, action: "namespaces.create", request }),
      render: (request) =>
        printFields([
          ["Action", "namespaces.create"],
          ["Name", request.name],
          ...metadataRows(request.metadata ?? {}),
        ]),
    },
    render: (created) =>
      printFields([
        ["ID", created.id],
        ["Name", created.name],
        ...metadataRows(created.metadata),
        ["Created", created.createdAt],
      ]),
  },
).pipe(
  Command.withDescription("Create a namespace, a sub-tenant for one of your customers"),
  Command.withExamples([
    { command: "samva namespaces create Acme --metadata customerId=cus_123" },
    { command: "samva namespaces create Acme --dry-run --json" },
  ]),
);

const get = deriveOverride(
  "get",
  { id: idArgument, json: jsonFlag },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => Namespaces.get(request),
    failure: "Could not get namespace",
    render: (namespace) =>
      printFields([
        ["ID", namespace.id],
        ["Name", namespace.name],
        ...metadataRows(namespace.metadata),
        ["Created", namespace.createdAt],
        ["Updated", namespace.updatedAt],
      ]),
  },
).pipe(
  Command.withDescription("Get a namespace and its metadata"),
  Command.withExamples([{ command: "samva namespaces get ns_7q2xk9mvt4znw8rh --json" }]),
);

const update = deriveOverride(
  "update",
  {
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
  },
  {
    prepare: ({ id, name, metadata, unsetMetadata }) =>
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
        return {
          id,
          ...Option.match(name, { onNone: () => ({}), onSome: (value) => ({ name: value }) }),
          ...(metadata.length === 0 && unsetMetadata.length === 0 ? {} : { metadata: merged }),
        };
      }),
    call: (request) => Namespaces.update(request),
    failure: "Could not update namespace",
    preview: {
      data: (request) => {
        const { id, ...payload } = request;
        return { dryRun: true, action: "namespaces.update", id, request: payload };
      },
      render: (request, input) => {
        const labels = Object.fromEntries(
          Object.entries(request.metadata ?? {}).filter(([, value]) => value !== null),
        ) as Record<string, string>;
        return printFields([
          ["Action", "namespaces.update"],
          ["Namespace", request.id],
          ["Name", Option.getOrUndefined(input.name)],
          ...metadataRows(labels),
          ...input.unsetMetadata.map((key) => [`Unset ${key}`, "yes"] as const),
        ]);
      },
    },
    render: (updated) =>
      printFields([
        ["ID", updated.id],
        ["Name", updated.name],
        ...metadataRows(updated.metadata),
        ["Updated", updated.updatedAt],
      ]),
  },
).pipe(
  Command.withDescription("Rename a namespace or change its metadata"),
  Command.withExamples([
    { command: "samva namespaces update ns_7q2xk9mvt4znw8rh --name Acme --metadata plan=pro" },
    { command: "samva namespaces update ns_7q2xk9mvt4znw8rh --unset-metadata plan" },
  ]),
);

const remove = deriveOverride(
  "delete",
  {
    id: idArgument,
    dryRun: dryRunFlag,
    yes: yesFlag(),
    json: jsonFlag,
  },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => Namespaces.remove(request),
    failure: "Could not delete namespace",
    preview: {
      data: (request) => ({ dryRun: true, action: "namespaces.delete", id: request.id }),
      render: (request) => Console.log(`[dry-run] Would delete namespace ${request.id}.`),
    },
    confirmation: (request) => ({
      message: `Delete namespace ${request.id}?`,
      nonInteractiveMessage:
        "Namespace deletion requires --yes in non-interactive mode. Preview with --dry-run.",
    }),
    render: (_result, _input, request) => Console.log(`Deleted namespace ${request.id}.`),
  },
).pipe(
  Command.withDescription(
    "Delete an empty namespace; one that still holds anything is refused with a count of what remains",
  ),
  Command.withExamples([
    { command: "samva namespaces delete ns_7q2xk9mvt4znw8rh --dry-run" },
    { command: "samva namespaces delete ns_7q2xk9mvt4znw8rh --yes" },
  ]),
);

const assign = deriveOverride(
  "assign",
  {
    id: idArgument,
    ...resourceFlags,
    dryRun: dryRunFlag,
    json: jsonFlag,
  },
  {
    prepare: ({ id, domain, sender, contact, template, whatsappNumber, smsNumber }) =>
      Effect.gen(function* () {
        const resource = chosenResource({
          domain,
          sender,
          contact,
          template,
          whatsappNumber,
          smsNumber,
        });
        if (Schema.is(CliUsageError)(resource)) return yield* resource;
        return { id, type: resource.type, resourceId: resource.id };
      }),
    call: (request) => Namespaces.assignResource(request),
    failure: "Could not assign resource",
    preview: {
      data: (request) => ({
        dryRun: true,
        action: "namespaces.assign",
        id: request.id,
        request: { type: request.type, id: request.resourceId },
      }),
      render: (request) =>
        Console.log(
          `[dry-run] Would move ${request.type} ${request.resourceId} into ${request.id}.`,
        ),
    },
    render: (moved) =>
      printFields([
        ["Type", moved.type],
        ["ID", moved.id],
        ["Namespace", moved.namespaceId],
      ]),
  },
).pipe(
  Command.withDescription(
    "Move a domain, sender, contact, template, or channel number into a namespace; pass exactly one resource flag",
  ),
  Command.withExamples([
    { command: "samva namespaces assign ns_7q2xk9mvt4znw8rh --domain dom_xyz789" },
    {
      command:
        "samva namespaces assign ns_7q2xk9mvt4znw8rh --contact contact_7q2xk9mvt4znw8rh --dry-run",
    },
  ]),
);

const unassign = deriveOverride(
  "unassign",
  {
    id: idArgument,
    ...resourceFlags,
    dryRun: dryRunFlag,
    json: jsonFlag,
  },
  {
    prepare: ({ id, domain, sender, contact, template, whatsappNumber, smsNumber }) =>
      Effect.gen(function* () {
        const resource = chosenResource({
          domain,
          sender,
          contact,
          template,
          whatsappNumber,
          smsNumber,
        });
        if (Schema.is(CliUsageError)(resource)) return yield* resource;
        return { id, type: resource.type, resourceId: resource.id };
      }),
    call: (request) => Namespaces.removeResource(request),
    failure: "Could not unassign resource",
    preview: {
      data: (request) => ({
        dryRun: true,
        action: "namespaces.unassign",
        id: request.id,
        request: { type: request.type, id: request.resourceId },
      }),
      render: (request) =>
        Console.log(
          `[dry-run] Would return ${request.type} ${request.resourceId} from ${request.id} to organization level.`,
        ),
    },
    render: (moved) =>
      printFields([
        ["Type", moved.type],
        ["ID", moved.id],
        ["Namespace", moved.namespaceId ?? "organization"],
      ]),
  },
).pipe(
  Command.withDescription(
    "Return a domain, sender, contact, template, or channel number to organization level; pass exactly one resource flag",
  ),
  Command.withExamples([
    { command: "samva namespaces unassign ns_7q2xk9mvt4znw8rh --domain dom_xyz789" },
  ]),
);

const usage = deriveOverride(
  "usage",
  {
    id: idArgument,
    after: optionalString("after", "Start of the window, an ISO 8601 instant"),
    before: optionalString("before", "End of the window, an ISO 8601 instant"),
    json: jsonFlag,
  },
  {
    mapInput: ({ id, after, before }) => ({
      id,
      after: Option.getOrUndefined(after),
      before: Option.getOrUndefined(before),
    }),
    call: (request) => Namespaces.getUsage(request),
    failure: "Could not get namespace usage",
    render: (data) =>
      printFields([
        ["Namespace", data.namespaceId],
        ["Period start", data.periodStart],
        ["Period end", data.periodEnd],
        ["Email", data.emailCount],
        ["Total", data.totalMessages],
      ]),
  },
).pipe(
  Command.withDescription("Count the messages a namespace sent and received in a window"),
  Command.withExamples([
    { command: "samva namespaces usage ns_7q2xk9mvt4znw8rh --after 2026-10-01T00:00:00Z --json" },
  ]),
);

export const namespacesCommand = Command.make("namespaces").pipe(
  Command.withDescription("Manage namespaces, the sub-tenants of your organization"),
  Command.withExamples([{ command: "samva namespaces list --json" }]),
  Command.withSubcommands([
    list,
    create,
    get,
    update,
    remove,
    assign,
    unassign,
    usage,
    namespacePortalLinks,
  ]),
);
