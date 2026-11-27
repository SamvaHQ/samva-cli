import { Effect, FileSystem, Option, Schema } from "effect";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Events from "samva/effect/events";

import { CliUsageError } from "../errors";
import { deriveOverride } from "../lib/derive/curated";
import { jsonFlag, printFields } from "../lib/output";
import { readStdinUtf8 } from "../lib/stdin";

const send = deriveOverride(
  "send",
  {
    data: Flag.String("data").pipe(Flag.withDescription("Event JSON, @file, or - for piped stdin")),
    idempotencyKey: Flag.String("idempotency-key").pipe(
      Flag.withSchema(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255))),
      Flag.withDescription("Stable retry key; generated per call when omitted"),
      Flag.optional,
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Validate request shape offline without recording an event"),
      Flag.withDefault(false),
    ),
    json: jsonFlag,
  },
  {
    prepare: ({ data }) =>
      Effect.gen(function* () {
        let source = data;
        if (data === "-") source = yield* readStdinUtf8;
        else if (data.startsWith("@")) {
          const path = data.slice(1);
          if (!path)
            return yield* new CliUsageError({
              code: "missing_data_file",
              message: "--data @ requires a file path. Try: samva events send --data @event.json",
            });
          const fs = yield* FileSystem.FileSystem;
          source = yield* fs.readFileString(path).pipe(
            Effect.mapError(
              () =>
                new CliUsageError({
                  code: "data_file_unreadable",
                  message: `Could not read event data from ${path}.`,
                }),
            ),
          );
        }
        const payload = yield* Schema.decodeEffect(
          Schema.fromJsonString(Events.CreateEventPayload),
        )(source, { onExcessProperty: "error", errors: "all" }).pipe(
          Effect.mapError(
            (error) =>
              new CliUsageError({
                code: "event_invalid",
                message: `--data must match the event schema with exactly one contact id, externalId, email, or E.164 phone number: ${String(error)}. Try: samva events send --help`,
              }),
          ),
        );
        return payload;
      }),
    call: (payload, { idempotencyKey }) =>
      Events.create(payload, { idempotencyKey: Option.getOrUndefined(idempotencyKey) }),
    failure: "Could not record contact event",
    preview: {
      data: (payload) => ({ dryRun: true, action: "events.send", request: payload }),
      render: (payload) =>
        printFields([
          ["Dry run", true],
          ["Event", JSON.stringify(payload)],
        ]),
    },
    render: (event) =>
      printFields([
        ["Event ID", event.id],
        ["Contact ID", event.contactId],
        ["Name", event.name],
        ["Source", event.source],
        ["Properties", JSON.stringify(event.properties)],
        ["Occurred", event.occurredAt],
        ["Recorded", event.recordedAt],
      ]),
  },
).pipe(
  Command.withDescription("Record one custom contact event"),
  Command.withExamples([
    {
      command: `samva events send --data '{"contact":{"email":"ada@example.com"},"name":"trial.started"}' --idempotency-key trial-42 --json`,
    },
    {
      command: `samva events send --data '{"contact":{"phone":"+12025550123"},"name":"trial.started"}' --json`,
    },
    { command: "samva events send --data @event.json --dry-run" },
    { command: "cat event.json | samva events send --data - --json" },
  ]),
);

export const eventsCommand = Command.make("events").pipe(
  Command.withDescription("Record custom contact events"),
  Command.withSubcommands([send]),
);
