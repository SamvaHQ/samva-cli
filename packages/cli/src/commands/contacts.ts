import { SetContactConsent } from "@samva/core/contacts/consent";
import { ContactId, ContactIdentityId } from "@samva/core/shared/base";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Contacts from "samva/effect/contacts";

import { CliUsageError, toCliApiError } from "../errors";
import { deriveOverride } from "../lib/derive/curated";
import { namespaceField, namespaceFlag } from "../lib/namespace";
import { jsonFlag, printFields } from "../lib/output";
import { importContacts, importStatus, resumeImport } from "./contacts-import";

const optionalString = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.optional);

const list = deriveOverride(
  "list",
  {
    search: optionalString("search", "Search contact names and identities"),
    status: Flag.Literals("status", ["active", "paused", "blocked", "archived"]).pipe(
      Flag.withDescription("Filter by contact status"),
      Flag.optional,
    ),
    fields: optionalString(
      "fields",
      "Comma-separated custom-field keys to include in each summary",
    ),
    customField: optionalString("custom-field", "Custom-field key to filter by exact value"),
    customFieldValue: optionalString(
      "custom-field-value",
      `JSON scalar to match, for example '"pro"' or true`,
    ),
    cursor: optionalString("cursor", "Resume after this nextCursor from a previous page"),
    limit: Flag.Int("limit").pipe(Flag.withDescription("Maximum contacts per page"), Flag.optional),
    after: optionalString("after", "Only contacts created after this ISO 8601 instant"),
    before: optionalString("before", "Only contacts created before this ISO 8601 instant"),
    namespace: namespaceFlag("list"),
    all: Flag.Boolean("all").pipe(
      Flag.withDescription("Traverse every page (requires --jsonl)"),
      Flag.withDefault(false),
    ),
    json: jsonFlag,
  },
  {
    prepare: ({
      search,
      status,
      fields,
      customField,
      customFieldValue,
      cursor,
      limit,
      after,
      before,
      namespace,
    }) =>
      Effect.gen(function* () {
        if (Option.isSome(customField) !== Option.isSome(customFieldValue)) {
          return yield* new CliUsageError({
            code: "custom_field_filter_incomplete",
            message: `--custom-field and --custom-field-value must be supplied together, for example --custom-field plan --custom-field-value '"pro"'.`,
          });
        }
        if (Option.isSome(customFieldValue)) {
          yield* Schema.decodeEffect(
            Schema.fromJsonString(
              Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]),
            ),
          )(customFieldValue.value).pipe(
            Effect.mapError(
              () =>
                new CliUsageError({
                  code: "invalid_custom_field_value",
                  message: `--custom-field-value must be a JSON scalar, for example '"pro"', 42, true, or null.`,
                }),
            ),
          );
        }
        return {
          search: Option.getOrUndefined(search),
          status: Option.getOrUndefined(status),
          fields: Option.getOrUndefined(fields),
          customField: Option.getOrUndefined(customField),
          customFieldValue: Option.getOrUndefined(customFieldValue),
          limit: Option.getOrUndefined(limit),
          after: Option.getOrUndefined(after),
          before: Option.getOrUndefined(before),
          cursor: Option.getOrUndefined(cursor),
          ...namespaceField(namespace),
        };
      }),
    call: (request) => Contacts.list(request),
    failure: (error, request) =>
      toCliApiError("Could not list contacts", error, { cursor: request.cursor ?? null }),
    paginate: {
      withCursor: (request, cursor) => ({ ...request, cursor }),
      start: (request) => request.cursor,
    },
    render: (data) =>
      Effect.gen(function* () {
        if (data.items.length === 0) return yield* Console.log("No contacts found.");
        for (const contact of data.items) {
          yield* printFields([
            ["Contact ID", contact.id],
            ["Name", contact.name],
            ["Display name", contact.displayName],
            ["Email", contact.email],
            ["Channels", contact.channels.join(", ")],
            ["Lists", JSON.stringify(contact.lists)],
            ["Last active", contact.lastActiveAt],
            ["Created", contact.createdAt],
            ["Status", contact.status],
            ["Namespace", contact.namespaceId ?? "organization"],
            ["Tags", contact.tags.join(", ")],
            [
              "Custom fields",
              contact.customFields === undefined ? undefined : JSON.stringify(contact.customFields),
            ],
          ]);
          yield* Console.log("");
        }
        if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
      }),
  },
).pipe(
  Command.withDescription(
    "List and search contacts with optional custom-field projection and filtering",
  ),
  Command.withExamples([
    { command: "samva contacts list --search ada --limit 25" },
    { command: "samva contacts list --fields plan,score --json" },
    { command: `samva contacts list --custom-field plan --custom-field-value '"pro"' --json` },
    { command: "samva contacts list --all --jsonl", description: "Stream every page as JSONL" },
  ]),
);

const get = deriveOverride(
  "get",
  {
    id: Argument.String("id").pipe(Argument.withDescription("Contact ID")),
    json: jsonFlag,
  },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => Contacts.get(request),
    failure: "Could not get contact",
    render: (contact) =>
      printFields([
        ["Contact ID", contact.id],
        ["Name", contact.name],
        ["Display name", contact.displayName],
        ["Avatar", contact.avatar],
        ["Status", contact.status],
        ["Namespace", contact.namespaceId ?? "organization"],
        ["Reason", contact.statusReason],
        ["External ID", contact.externalId],
        ["Identities", JSON.stringify(contact.identities)],
        ["Tags", contact.tags.join(", ")],
        ["Profile", contact.profile === null ? null : JSON.stringify(contact.profile)],
        ["Preferences", contact.preferences === null ? null : JSON.stringify(contact.preferences)],
        ["Metadata", contact.metadata === null ? null : JSON.stringify(contact.metadata)],
        ["Created", contact.createdAt],
        ["Updated", contact.updatedAt],
      ]),
  },
).pipe(
  Command.withDescription("Get a contact's identities, profile, custom fields, and metadata"),
  Command.withExamples([{ command: "samva contacts get contact_7q2xk9mvt4znw8rh --json" }]),
);

const events = deriveOverride(
  "events",
  {
    id: Argument.String("contact").pipe(Argument.withDescription("Contact ID")),
    cursor: optionalString("cursor", "Resume after a previous nextCursor"),
    limit: Flag.Int("limit").pipe(Flag.withDescription("Maximum events per page"), Flag.optional),
    all: Flag.Boolean("all").pipe(
      Flag.withDescription("Traverse every page (requires --jsonl)"),
      Flag.withDefault(false),
    ),
    json: jsonFlag,
  },
  {
    mapInput: ({ id, cursor, limit }) => ({
      id,
      cursor: Option.getOrUndefined(cursor),
      limit: Option.getOrUndefined(limit),
    }),
    call: (request) => Contacts.listEvents(request),
    failure: (error, request) =>
      toCliApiError("Could not list contact events", error, { cursor: request.cursor ?? null }),
    paginate: {
      withCursor: (request, cursor) => ({ ...request, cursor }),
      start: (request) => request.cursor,
    },
    render: (page) =>
      Effect.gen(function* () {
        if (!page.items.length) yield* Console.log("No contact events found.");
        for (const event of page.items) {
          yield* printFields([
            ["Event ID", event.id],
            ["Contact ID", event.contactId],
            ["Name", event.name],
            ["Source", event.source],
            ["Properties", JSON.stringify(event.properties)],
            ["Occurred", event.occurredAt],
            ["Recorded", event.recordedAt],
          ]);
          yield* Console.log("");
        }
        if (page.nextCursor !== null) yield* printFields([["Next cursor", page.nextCursor]]);
      }),
  },
).pipe(
  Command.withDescription("Read a contact's custom and lifecycle event timeline"),
  Command.withExamples([
    { command: "samva contacts events contact_7q2xk9mvt4znw8rh --limit 25 --json" },
    { command: "samva contacts events contact_7q2xk9mvt4znw8rh --all --jsonl" },
  ]),
);

const merge = deriveOverride(
  "merge",
  {
    id: Argument.String("id").pipe(Argument.withDescription("Contact ID to keep")),
    from: Flag.String("from").pipe(Flag.withDescription("Contact ID to absorb")),
    yes: Flag.Boolean("yes").pipe(
      Flag.withDescription("Confirm the merge"),
      Flag.withDefault(false),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Preview without merging"),
      Flag.withDefault(false),
    ),
    json: jsonFlag,
  },
  {
    prepare: ({ id, from }) =>
      id === from
        ? Effect.fail(
            new CliUsageError({
              code: "self_merge",
              message: "Choose two different contacts to merge.",
            }),
          )
        : Effect.succeed({ id, from }),
    call: (request) => Contacts.merge(request),
    failure: "Could not merge contacts",
    preview: {
      data: (request) => ({ dryRun: true, action: "contacts.merge", ...request }),
      render: (request) => Console.log(`[dry-run] Would merge ${request.from} into ${request.id}.`),
    },
    confirmation: (request) => ({
      message: `Merge ${request.from} into ${request.id}? This cannot be undone.`,
      nonInteractiveMessage:
        "Merging contacts requires --yes in non-interactive mode. Preview with --dry-run.",
    }),
    render: (contact, _input, request) =>
      printFields([
        ["Contact ID", contact.id],
        ["Name", contact.name],
        ["Absorbed contact", request.from],
      ]),
  },
).pipe(
  Command.withDescription(
    "Merge another contact into this one, preserving identities and activity. This cannot be undone.",
  ),
  Command.withExamples([
    {
      command:
        "samva contacts merge contact_7q2xk9mvt4znw8rh --from contact_9z4wx8jqm2rkt6ps --yes --json",
    },
  ]),
);

const consent = deriveOverride(
  "set-consent",
  {
    id: Argument.String("contact-id").pipe(Argument.withSchema(ContactId)),
    identityId: Argument.String("identity-id").pipe(Argument.withSchema(ContactIdentityId)),
    channel: Flag.Literals("channel", ["email", "whatsapp", "sms"]),
    status: Flag.Literals("status", SetContactConsent.fields.status.literals),
    source: Flag.String("source").pipe(Flag.withSchema(SetContactConsent.fields.source)),
    capturedAt: Flag.String("captured-at").pipe(
      Flag.withSchema(SetContactConsent.fields.capturedAt),
      Flag.withDescription("ISO 8601 time at which the contact gave or withdrew consent"),
    ),
    yes: Flag.Boolean("yes"),
    json: jsonFlag,
  },
  {
    mapInput: ({ id, identityId, channel, status, source, capturedAt }) => ({
      id,
      identityId,
      channel,
      status,
      source,
      capturedAt: capturedAt.toISOString(),
    }),
    call: (request) => Contacts.setConsent(request),
    failure: "Could not record contact consent",
    confirmation: (request) => ({
      message: `Record ${request.status} for contact ${request.id}, identity ${request.identityId}, on ${request.channel}?`,
      nonInteractiveMessage: "Confirm the explicit consent change with --yes.",
    }),
    render: (_result, _input, request) =>
      printFields([
        ["Contact ID", request.id],
        ["Identity ID", request.identityId],
        ["Consent", request.status],
      ]),
  },
).pipe(
  Command.withDescription(
    "Record a contact's explicit consent decision on one identity and channel",
  ),
);

export const contactsCommand = Command.make("contacts").pipe(
  Command.withDescription("List, inspect, and import contacts"),
  Command.withExamples([{ command: "samva contacts list --search ada --json" }]),
  Command.withSubcommands([
    list,
    get,
    events,
    merge,
    consent,
    importContacts,
    importStatus,
    resumeImport,
  ]),
);
