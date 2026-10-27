import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Contacts from "samva/effect/contacts";

import { CliUsageError, toCliApiError } from "../errors";
import { getClientProvider } from "../lib/client";
import { namespaceField, namespaceFlag } from "../lib/namespace";
import { jsonFlag, printFields, printJson, printJsonLine } from "../lib/output";
import { isJsonLinesRequested } from "../lib/runtime";
import { importContacts, importStatus, resumeImport } from "./contacts-import";

const optionalString = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.optional);

const list = Command.make("list", {
  search: optionalString("search", "Search contact names and identities"),
  status: Flag.Literals("status", ["active", "paused", "blocked", "archived"]).pipe(
    Flag.withDescription("Filter by contact status"),
    Flag.optional,
  ),
  fields: optionalString("fields", "Comma-separated custom-field keys to include in each summary"),
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
}).pipe(
  Command.withDescription(
    "List and search contacts with optional custom-field projection and filtering",
  ),
  Command.withExamples([
    { command: "samva contacts list --search ada --limit 25" },
    { command: "samva contacts list --fields plan,score --json" },
    { command: `samva contacts list --custom-field plan --custom-field-value '"pro"' --json` },
    { command: "samva contacts list --all --jsonl", description: "Stream every page as JSONL" },
  ]),
  Command.withHandler(
    ({
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
      all,
      json,
    }) =>
      Effect.gen(function* () {
        if (all && !isJsonLinesRequested()) {
          return yield* new CliUsageError({
            code: "all_requires_jsonl",
            message: "--all is an unbounded traversal and requires --jsonl.",
          });
        }
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
        const client = yield* getClientProvider;
        const query = {
          search: Option.getOrUndefined(search),
          status: Option.getOrUndefined(status),
          fields: Option.getOrUndefined(fields),
          customField: Option.getOrUndefined(customField),
          customFieldValue: Option.getOrUndefined(customFieldValue),
          limit: Option.getOrUndefined(limit),
          after: Option.getOrUndefined(after),
          before: Option.getOrUndefined(before),
          ...namespaceField(namespace),
        };
        const listPage = (pageCursor: string | undefined) =>
          Contacts.list({ ...query, cursor: pageCursor }).pipe(
            client.provide,
            Effect.mapError((error) =>
              toCliApiError("Could not list contacts", error, { cursor: pageCursor ?? null }),
            ),
          );
        let nextCursor = Option.getOrUndefined(cursor);
        for (;;) {
          const data = yield* listPage(nextCursor);
          if (isJsonLinesRequested()) {
            for (const item of data.items) yield* printJsonLine(item);
          } else if (json) {
            return yield* printJson(data);
          } else {
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
                  contact.customFields === undefined
                    ? undefined
                    : JSON.stringify(contact.customFields),
                ],
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

const get = Command.make("get", {
  id: Argument.String("id").pipe(Argument.withDescription("Contact ID")),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Get a contact's identities, profile, custom fields, and metadata"),
  Command.withExamples([{ command: "samva contacts get contact_7q2xk9mvt4znw8rh --json" }]),
  Command.withHandler(({ id, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const contact = yield* Contacts.get({ id }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not get contact", error)),
      );
      if (json) return yield* printJson(contact);
      yield* printFields([
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
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const events = Command.make("events", {
  id: Argument.String("contact").pipe(Argument.withDescription("Contact ID")),
  cursor: optionalString("cursor", "Resume after a previous nextCursor"),
  limit: Flag.Int("limit").pipe(Flag.withDescription("Maximum events per page"), Flag.optional),
  all: Flag.Boolean("all").pipe(
    Flag.withDescription("Traverse every page (requires --jsonl)"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Read a contact's custom and lifecycle event timeline"),
  Command.withExamples([
    { command: "samva contacts events contact_7q2xk9mvt4znw8rh --limit 25 --json" },
    { command: "samva contacts events contact_7q2xk9mvt4znw8rh --all --jsonl" },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, cursor, limit, all, json }) {
      if (all && !isJsonLinesRequested())
        return yield* new CliUsageError({
          code: "all_requires_jsonl",
          message: "--all is an unbounded traversal and requires --jsonl.",
        });
      const client = yield* getClientProvider;
      let nextCursor = Option.getOrUndefined(cursor);
      for (;;) {
        const page = yield* Contacts.listEvents({
          id,
          cursor: nextCursor,
          limit: Option.getOrUndefined(limit),
        }).pipe(
          client.provide,
          Effect.mapError((error) =>
            toCliApiError("Could not list contact events", error, { cursor: nextCursor ?? null }),
          ),
        );
        if (isJsonLinesRequested()) {
          for (const event of page.items) yield* printJsonLine(event);
        } else if (json) return yield* printJson(page);
        else {
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
        }
        if (!all || page.nextCursor === null) return;
        nextCursor = page.nextCursor;
      }
    }),
  ),
);

export const contactsCommand = Command.make("contacts").pipe(
  Command.withDescription("List, inspect, and import contacts"),
  Command.withExamples([{ command: "samva contacts list --search ada --json" }]),
  Command.withSubcommands([list, get, events, importContacts, importStatus, resumeImport]),
);
