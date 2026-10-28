import { Effect, FileSystem, Option, Schema } from "effect";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Events from "samva/effect/events";

import { CliUsageError, toCliApiError } from "../errors";
import { getClientProvider } from "../lib/client";
import { jsonFlag, printFields, printJson } from "../lib/output";
import { readStdinUtf8 } from "../lib/stdin";

const send = Command.make("send", {
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
}).pipe(
  Command.withDescription("Record one custom contact event"),
  Command.withExamples([
    {
      command: `samva events send --data '{"contact":{"email":"ada@example.com"},"name":"trial.started"}' --idempotency-key trial-42 --json`,
    },
    { command: "samva events send --data @event.json --dry-run" },
    { command: "cat event.json | samva events send --data - --json" },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ data, idempotencyKey, dryRun, json }) {
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
      const payload = yield* Schema.decodeEffect(Schema.fromJsonString(Events.CreateEventPayload))(
        source,
        { onExcessProperty: "error" },
      ).pipe(
        Effect.mapError(
          (error) =>
            new CliUsageError({
              code: "event_invalid",
              message: `--data must match the event schema with exactly one contact id, externalId, or email: ${String(error)}. Try: samva events send --help`,
            }),
        ),
      );
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "events.send", request: payload })
          : printFields([
              ["Dry run", true],
              ["Event", JSON.stringify(payload)],
            ]);
      const client = yield* getClientProvider;
      const event = yield* Events.create(payload, {
        idempotencyKey: Option.getOrUndefined(idempotencyKey),
      }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not record contact event", error)),
      );
      if (json) return yield* printJson(event);
      yield* printFields([
        ["Event ID", event.id],
        ["Contact ID", event.contactId],
        ["Name", event.name],
        ["Source", event.source],
        ["Properties", JSON.stringify(event.properties)],
        ["Occurred", event.occurredAt],
        ["Recorded", event.recordedAt],
      ]);
    }),
  ),
);

export const eventsCommand = Command.make("events").pipe(
  Command.withDescription("Record custom contact events"),
  Command.withSubcommands([send]),
);
