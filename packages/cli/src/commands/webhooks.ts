import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Webhooks from "samva/effect/webhooks";

import { CliUsageError, SamvaCliError, toCliApiError } from "../errors";
import { getClientProvider } from "../lib/client";
import { confirmDestructive } from "../lib/confirm";
import { jsonFlag, objectRows, printFields, printJson, printJsonLine } from "../lib/output";
import { isJsonLinesRequested } from "../lib/runtime";

const idArgument = Argument.String("id").pipe(Argument.withDescription("Webhook id"));
const parseObject = (raw: string, flag: string) =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: () => new SamvaCliError({ message: `${flag} must be a valid JSON object.` }),
  }).pipe(
    Effect.filterOrFail(
      (value): value is Record<string, unknown> =>
        Predicate.isObject(value) && !Array.isArray(value),
      () => new SamvaCliError({ message: `${flag} must be a non-null JSON object.` }),
    ),
  );
const decodePayload = <A>(raw: string, flag: string, schema: Schema.Codec<A, unknown>) =>
  parseObject(raw, flag).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError((error) =>
      error instanceof SamvaCliError
        ? error
        : new SamvaCliError({ message: `${flag} does not match the API schema: ${String(error)}` }),
    ),
  );
const readData = (raw: string) => {
  if (!raw.startsWith("@")) return Effect.succeed(raw);
  const path = raw.slice(1);
  if (path.length === 0) {
    return Effect.fail(
      new CliUsageError({ code: "missing_data_file", message: "--data @ requires a file path." }),
    );
  }
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(path);
  }).pipe(
    Effect.mapError(
      () =>
        new CliUsageError({
          code: "data_file_unreadable",
          message: `Could not read webhook test data from ${path}.`,
        }),
    ),
  );
};
const list = Command.make("list", {
  cursor: Flag.String("cursor").pipe(
    Flag.withDescription("Resume after this nextCursor from a previous page"),
    Flag.optional,
  ),
  limit: Flag.Int("limit").pipe(Flag.withDescription("Items per page"), Flag.optional),
  all: Flag.Boolean("all").pipe(
    Flag.withDescription("Traverse every page (requires --jsonl)"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List customer webhooks"),
  Command.withExamples([{ command: "samva webhooks list --json" }]),
  Command.withHandler(({ cursor, limit, all, json }) =>
    Effect.gen(function* () {
      if (all && !isJsonLinesRequested())
        return yield* new CliUsageError({
          code: "all_requires_jsonl",
          message: "--all is an unbounded traversal and requires --jsonl.",
        });
      const client = yield* getClientProvider;
      const cursorValue = Option.getOrUndefined(cursor);
      const limitValue = Option.getOrUndefined(limit);
      const query = { cursor: cursorValue, limit: limitValue };
      if (all) {
        let nextCursor = cursorValue;
        for (;;) {
          const data = yield* Webhooks.list({ ...query, cursor: nextCursor }).pipe(
            client.provide,
            Effect.mapError((error) => toCliApiError("Could not list webhooks", error)),
          );
          for (const item of data.items) yield* printJsonLine(item);
          if (data.nextCursor === null) return;
          nextCursor = data.nextCursor;
        }
      }
      const data = yield* Webhooks.list(query).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not list webhooks", error)),
      );
      if (isJsonLinesRequested()) {
        for (const item of data.items) yield* printJsonLine(item);
        return;
      }
      if (json) return yield* printJson(data);
      if (data.items.length === 0) return yield* Console.log("No webhooks found.");
      for (const hook of data.items)
        yield* printFields([
          ["ID", hook.id],
          ["Name", hook.name],
          ["Status", hook.status],
          ["URL", hook.url],
        ]);
      if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
const get = Command.make("get", { id: idArgument, json: jsonFlag }).pipe(
  Command.withDescription("Get a customer webhook"),
  Command.withExamples([{ command: "samva webhooks get wep_abc123 --json" }]),
  Command.withHandler(({ id, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Webhooks.get({ id }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not get webhook", error)),
      );
      if (json) return yield* printJson(data);
      yield* printFields([
        ["ID", data.id],
        ["Name", data.name],
        ["Status", data.status],
        ["URL", data.url],
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
const secret = Command.make("secret", { id: idArgument, json: jsonFlag }).pipe(
  Command.withDescription("Read the current webhook signing secret (requires webhooks:update)"),
  Command.withExamples([{ command: "samva webhooks secret wep_abc123 --json" }]),
  Command.withHandler(({ id, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Webhooks.getSecret({ id }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not read webhook signing secret", error)),
      );
      if (json) return yield* printJson({ ...data, secret: Redacted.value(data.secret) });
      yield* printFields([
        ["Signing secret", Redacted.value(data.secret)],
        ["Created at", data.createdAt],
      ]);
      if (data.previousExpiresAt !== null)
        yield* Console.log(`The previous secret keeps verifying until ${data.previousExpiresAt}.`);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
const logs = Command.make("logs", {
  id: idArgument,
  limit: Flag.Int("limit").pipe(Flag.optional),
  cursor: Flag.String("cursor").pipe(
    Flag.withDescription("Resume after this nextCursor from a previous page"),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List webhook delivery logs, newest first"),
  Command.withExamples([{ command: "samva webhooks logs wep_abc123 --limit 25 --json" }]),
  Command.withHandler(({ id, limit, cursor, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const limitValue = Option.getOrUndefined(limit);
      const data = yield* Webhooks.getLogs({
        id,
        cursor: Option.getOrUndefined(cursor),
        ...(limitValue === undefined ? {} : { limit: limitValue }),
      }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not list webhook logs", error)),
      );
      if (json) return yield* printJson(data);
      if (data.items.length === 0) return yield* Console.log("No deliveries found.");
      for (const [index, delivery] of data.items.entries()) {
        if (index > 0) yield* Console.log("");
        yield* printFields([
          ["Delivery", delivery.id],
          ["Event", delivery.eventId],
          ["Event type", delivery.eventType],
          ["Status", delivery.status],
          ["Automatic attempts", delivery.automaticAttempts],
          ["Occurred", delivery.occurredAt],
          ["Next attempt", delivery.nextAttemptAt],
          ["Completed", delivery.completedAt],
          ["Created", delivery.createdAt],
          ["Updated", delivery.updatedAt],
          ...delivery.attempts.flatMap((attempt) => {
            const label = `Attempt ${attempt.attemptNumber}`;
            return [
              [
                label,
                [
                  attempt.id,
                  attempt.kind,
                  attempt.classification,
                  attempt.responseStatus === null
                    ? "no response"
                    : `HTTP ${attempt.responseStatus}`,
                  attempt.durationMs === null ? null : `${attempt.durationMs} ms`,
                  attempt.attemptedAt,
                ]
                  .filter((part) => part !== null)
                  .join("  "),
              ],
              [
                `${label} error`,
                [attempt.errorCode, attempt.errorMessage]
                  .filter((part) => part !== null)
                  .join(": "),
              ],
              [
                `${label} headers`,
                Object.entries(attempt.responseHeaders ?? {})
                  .map(([name, value]) => `${name}: ${value}`)
                  .join("; "),
              ],
              [`${label} recorded`, attempt.createdAt],
            ] as const;
          }),
        ]);
      }
      if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
const statsAfterFlag = Flag.String("after").pipe(
  Flag.withDescription("Start of the daily series, an ISO 8601 instant (default: 30 days back)"),
  Flag.optional,
);
const statsBeforeFlag = Flag.String("before").pipe(
  Flag.withDescription("End of the daily series, an ISO 8601 instant (default: end of today)"),
  Flag.optional,
);
const stats = Command.make("stats", {
  id: idArgument,
  after: statsAfterFlag,
  before: statsBeforeFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Get webhook delivery statistics"),
  Command.withExamples([
    { command: "samva webhooks stats wep_abc123 --after 2026-07-01T00:00:00Z --json" },
  ]),
  Command.withHandler(({ id, after, before, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Webhooks.getStats({
        id,
        after: Option.getOrUndefined(after),
        before: Option.getOrUndefined(before),
      }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not get webhook stats", error)),
      );
      if (json) return yield* printJson(data);
      yield* printFields([
        ["Total", data.total],
        ["Pending", data.pending],
        ["Delivered", data.delivered],
        ["Exhausted", data.exhausted],
        ["Cancelled", data.cancelled],
        ...data.daily.map(
          (day) =>
            [
              day.date,
              `${day.pending} pending, ${day.delivered} delivered, ${day.exhausted} exhausted, ${day.cancelled} cancelled`,
            ] as const,
        ),
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
const test = Command.make("test", {
  id: idArgument,
  data: Flag.String("data").pipe(
    Flag.withDescription("JSON object or @file to send as the signed test payload"),
    Flag.optional,
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Validate and preview without sending a request"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Queue a signed webhook.test delivery to a webhook endpoint"),
  Command.withExamples([
    { command: "samva webhooks test wep_abc123 --dry-run" },
    { command: `samva webhooks test wep_abc123 --data '{"event":"webhook.test"}' --json` },
    { command: "samva webhooks test wep_abc123 --data @payload.json --json" },
  ]),
  Command.withHandler(({ id, data, dryRun, json }) =>
    Effect.gen(function* () {
      const raw = Option.getOrUndefined(data);
      const payload =
        raw === undefined
          ? yield* Schema.decodeEffect(Webhooks.TestPayload)({})
          : yield* readData(raw).pipe(
              Effect.flatMap((content) => parseObject(content, "--data")),
              Effect.flatMap((value) =>
                Schema.decodeUnknownEffect(Webhooks.TestPayload)({ data: value }),
              ),
              Effect.mapError((error) =>
                error instanceof CliUsageError || error instanceof SamvaCliError
                  ? error
                  : new SamvaCliError({
                      message: `--data does not match the API schema: ${String(error)}`,
                    }),
              ),
            );

      if (dryRun) {
        const preview = { dryRun: true, action: "webhooks.test", id, request: payload };
        return yield* json
          ? printJson(preview)
          : printFields([
              ["Action", "webhooks.test"],
              ["Webhook", id],
              ["Payload", payload.data ? JSON.stringify(payload.data) : "default"],
            ]);
      }

      const client = yield* getClientProvider;
      const result = yield* Webhooks.test({ id, ...payload }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not test webhook", error)),
      );
      if (json) return yield* printJson(result);
      yield* printFields([
        ["Status", "Queued"],
        ["Event", result.eventId],
        ["Delivery", result.deliveryId],
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
const retry = Command.make("retry", {
  id: idArgument,
  deliveryId: Argument.String("delivery-id").pipe(Argument.withDescription("Webhook delivery id")),
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Retry a failed webhook delivery"),
  Command.withExamples([{ command: "samva webhooks retry wep_abc123 whdel_abc123 --dry-run" }]),
  Command.withHandler(({ id, deliveryId, dryRun, json }) =>
    Effect.gen(function* () {
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "webhooks.retry", id, deliveryId })
          : Console.log(`[dry-run] Would retry delivery ${deliveryId} for webhook ${id}.`);
      const client = yield* getClientProvider;
      const data = yield* Webhooks.retryDelivery({ id, deliveryId }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not retry webhook delivery", error)),
      );
      if (json) return yield* printJson(data);
      yield* printFields([
        ["Status", data.outcome === "succeeded" ? "Retried" : "Retry failed"],
        ["Accepted", data.accepted],
        ["Delivery", data.deliveryId],
        ["Attempt", data.attemptId],
        ["Outcome", data.outcome],
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
const rotate = Command.make("rotate-secret", {
  id: idArgument,
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Rotate a webhook signing secret"),
  Command.withExamples([
    { command: "samva webhooks rotate-secret wep_abc123 --dry-run" },
    { command: "samva webhooks rotate-secret wep_abc123 --yes --json" },
  ]),
  Command.withHandler(({ id, dryRun, yes, json }) =>
    Effect.gen(function* () {
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "webhooks.rotate-secret", id })
          : Console.log(`[dry-run] Would rotate the signing secret for webhook ${id}.`);
      yield* confirmDestructive({
        yes,
        json,
        message: `Rotate the signing secret for webhook ${id}? The previous secret keeps verifying for 24 hours.`,
        nonInteractiveMessage:
          "Secret rotation requires --yes in non-interactive mode. Preview with --dry-run.",
      });
      const client = yield* getClientProvider;
      const data = yield* Webhooks.regenerateSecret({ id }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not rotate webhook secret", error)),
      );
      const warning = `Read this signing secret again with samva webhooks secret ${id}. The previous secret remains valid for 24 hours.`;
      // The signing secret is Redacted on the Effect surface; unwrap it here so
      // the caller actually receives the value they asked to rotate.
      const signingSecret = Redacted.value(data.secret);
      if (json) return yield* printJson({ secret: signingSecret, warning });
      yield* Console.error(`WARNING: ${warning}`);
      yield* Console.log(signingSecret);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const create = Command.make("create", {
  data: Flag.String("data").pipe(
    Flag.withDescription("Webhook JSON: name, url, eventTypes, and optional retry settings"),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create a customer webhook from JSON"),
  Command.withExamples([
    {
      command: `samva webhooks create --data '{"name":"delivery","url":"https://example.com/hook","eventTypes":["message.delivered"]}' --dry-run`,
    },
  ]),
  Command.withHandler(({ data, dryRun, json }) =>
    Effect.gen(function* () {
      const payload = yield* decodePayload(data, "--data", Webhooks.CreatePayload);
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "webhooks.create", request: payload })
          : printFields([
              ["Action", "webhooks.create"],
              ...objectRows(payload, { explicit: true }),
            ]);
      const client = yield* getClientProvider;
      const result = yield* Webhooks.create(payload).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not create webhook", error)),
      );
      const warning = `Read this signing secret again with samva webhooks secret ${result.endpoint.id}.`;
      const signingSecret = Redacted.value(result.secret);
      if (json) {
        return yield* printJson({ endpoint: result.endpoint, secret: signingSecret, warning });
      }
      yield* Console.error(`WARNING: ${warning}`);
      yield* printFields([
        ["ID", result.endpoint.id],
        ["Name", result.endpoint.name],
        ["Status", result.endpoint.status],
        ["URL", result.endpoint.url],
        ["Signing secret", signingSecret],
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const update = Command.make("update", {
  id: idArgument,
  data: Flag.String("data").pipe(Flag.withDescription("JSON object of webhook fields to update")),
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Update a customer webhook from JSON"),
  Command.withExamples([
    {
      command: `samva webhooks update wep_abc123 --data '{"url":"https://example.com/new"}' --dry-run`,
    },
  ]),
  Command.withHandler(({ id, data, dryRun, json }) =>
    Effect.gen(function* () {
      const payload = yield* decodePayload(data, "--data", Webhooks.UpdatePayload);
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "webhooks.update", id, request: payload })
          : printFields([
              ["Action", "webhooks.update"],
              ["Webhook", id],
              ...objectRows(payload, { explicit: true }),
            ]);
      const client = yield* getClientProvider;
      const result = yield* Webhooks.update({ id, ...payload }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not update webhook", error)),
      );
      if (json) return yield* printJson(result);
      yield* printFields(objectRows(result));
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const remove = Command.make("remove", {
  id: idArgument,
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Permanently delete a customer webhook"),
  Command.withExamples([
    { command: "samva webhooks remove wep_abc123 --dry-run" },
    { command: "samva webhooks remove wep_abc123 --yes" },
  ]),
  Command.withHandler(({ id, dryRun, yes, json }) =>
    Effect.gen(function* () {
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "webhooks.remove", id })
          : Console.log(`[dry-run] Would permanently remove webhook ${id}.`);
      yield* confirmDestructive({
        yes,
        json,
        message: `Permanently remove webhook ${id}?`,
        nonInteractiveMessage:
          "Permanent webhook deletion requires --yes in non-interactive mode. Preview with --dry-run.",
      });
      const client = yield* getClientProvider;
      const result = yield* Webhooks.remove({ id }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not remove webhook", error)),
      );
      if (json) return yield* printJson(result);
      yield* Console.log(`Removed webhook ${id}.`);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
export const webhooksCommand = Command.make("webhooks").pipe(
  Command.withDescription("Inspect, test, and recover customer webhooks"),
  Command.withExamples([{ command: "samva webhooks list --json" }]),
  Command.withSubcommands([
    list,
    get,
    secret,
    create,
    update,
    test,
    logs,
    stats,
    retry,
    rotate,
    remove,
  ]),
);
