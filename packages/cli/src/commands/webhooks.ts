import { NamespaceId } from "@samva/core/shared/base";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Webhooks from "samva/effect/webhooks";

import { CliUsageError, SamvaCliError } from "../errors";
import { deriveOverride } from "../lib/derive/curated";
import { jsonFlag, objectRows, printFields } from "../lib/output";

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
    Effect.flatMap((input) =>
      Schema.decodeEffect(schema)(input, { onExcessProperty: "error", errors: "all" }),
    ),
    Effect.mapError((error) =>
      Schema.is(SamvaCliError)(error)
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
const list = deriveOverride(
  "list",
  {
    namespace: Flag.String("namespace").pipe(Flag.withSchema(NamespaceId), Flag.optional),
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
  },
  {
    mapInput: ({ namespace, cursor, limit }) => ({
      cursor: Option.getOrUndefined(cursor),
      limit: Option.getOrUndefined(limit),
      namespaceId: Option.getOrUndefined(namespace),
    }),
    call: (request) => Webhooks.list(request),
    failure: "Could not list webhooks",
    paginate: {
      withCursor: (request, cursor) => ({ ...request, cursor }),
      start: (request) => request.cursor,
    },
    render: (data) =>
      Effect.gen(function* () {
        if (data.items.length === 0) return yield* Console.log("No webhooks found.");
        for (const hook of data.items)
          yield* printFields([
            ["ID", hook.id],
            ["Name", hook.name],
            ["Status", hook.status],
            ["URL", hook.url],
          ]);
        if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
      }),
  },
).pipe(
  Command.withDescription("List customer webhooks"),
  Command.withExamples([{ command: "samva webhooks list --json" }]),
);
const get = deriveOverride(
  "get",
  { id: idArgument, json: jsonFlag },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => Webhooks.get(request),
    failure: "Could not get webhook",
    render: (data) =>
      printFields([
        ["ID", data.id],
        ["Name", data.name],
        ["Status", data.status],
        ["URL", data.url],
      ]),
  },
).pipe(
  Command.withDescription("Get a customer webhook"),
  Command.withExamples([{ command: "samva webhooks get wep_abc123 --json" }]),
);
const secret = deriveOverride(
  "secret",
  { id: idArgument, json: jsonFlag },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => Webhooks.getSecret(request),
    failure: "Could not read webhook signing secret",
    mapOutput: (data) => ({ ...data, secret: Redacted.value(data.secret) }),
    render: (data) =>
      Effect.gen(function* () {
        yield* printFields([
          ["Signing secret", Redacted.value(data.secret)],
          ["Created at", data.createdAt],
        ]);
        if (data.previousExpiresAt !== null)
          yield* Console.log(
            `The previous secret keeps verifying until ${data.previousExpiresAt}.`,
          );
      }),
  },
).pipe(
  Command.withDescription("Read the current webhook signing secret (requires webhooks:update)"),
  Command.withExamples([{ command: "samva webhooks secret wep_abc123 --json" }]),
);
const logs = deriveOverride(
  "logs",
  {
    id: idArgument,
    limit: Flag.Int("limit").pipe(Flag.optional),
    cursor: Flag.String("cursor").pipe(
      Flag.withDescription("Resume after this nextCursor from a previous page"),
      Flag.optional,
    ),
    json: jsonFlag,
  },
  {
    mapInput: ({ id, limit, cursor }) => ({
      id,
      cursor: Option.getOrUndefined(cursor),
      limit: Option.getOrUndefined(limit),
    }),
    call: (request) => Webhooks.getLogs(request),
    failure: "Could not list webhook logs",
    render: (data) =>
      Effect.gen(function* () {
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
      }),
  },
).pipe(
  Command.withDescription("List webhook delivery logs, newest first"),
  Command.withExamples([{ command: "samva webhooks logs wep_abc123 --limit 25 --json" }]),
);
const statsAfterFlag = Flag.String("after").pipe(
  Flag.withDescription("Start of the daily series, an ISO 8601 instant (default: 30 days back)"),
  Flag.optional,
);
const statsBeforeFlag = Flag.String("before").pipe(
  Flag.withDescription("End of the daily series, an ISO 8601 instant (default: end of today)"),
  Flag.optional,
);
const stats = deriveOverride(
  "stats",
  {
    id: idArgument,
    after: statsAfterFlag,
    before: statsBeforeFlag,
    json: jsonFlag,
  },
  {
    mapInput: ({ id, after, before }) => ({
      id,
      after: Option.getOrUndefined(after),
      before: Option.getOrUndefined(before),
    }),
    call: (request) => Webhooks.getStats(request),
    failure: "Could not get webhook stats",
    render: (data) =>
      printFields([
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
      ]),
  },
).pipe(
  Command.withDescription("Get webhook delivery statistics"),
  Command.withExamples([
    { command: "samva webhooks stats wep_abc123 --after 2026-07-01T00:00:00Z --json" },
  ]),
);
const test = deriveOverride(
  "test",
  {
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
  },
  {
    prepare: ({ id, data }) =>
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
                  Schema.is(CliUsageError)(error) || Schema.is(SamvaCliError)(error)
                    ? error
                    : new SamvaCliError({
                        message: `--data does not match the API schema: ${String(error)}`,
                      }),
                ),
              );
        return { id, ...payload };
      }),
    call: (request) => Webhooks.test(request),
    failure: "Could not test webhook",
    preview: {
      data: (request) => {
        const { id, ...payload } = request;
        return { dryRun: true, action: "webhooks.test", id, request: payload };
      },
      render: (request) => {
        const { id, ...payload } = request;
        return printFields([
          ["Action", "webhooks.test"],
          ["Webhook", id],
          ["Payload", payload.data ? JSON.stringify(payload.data) : "default"],
        ]);
      },
    },
    render: (result) =>
      printFields([
        ["Status", "Queued"],
        ["Event", result.eventId],
        ["Delivery", result.deliveryId],
      ]),
  },
).pipe(
  Command.withDescription("Queue a signed webhook.test delivery to a webhook endpoint"),
  Command.withExamples([
    { command: "samva webhooks test wep_abc123 --dry-run" },
    { command: `samva webhooks test wep_abc123 --data '{"event":"webhook.test"}' --json` },
    { command: "samva webhooks test wep_abc123 --data @payload.json --json" },
  ]),
);
const retry = deriveOverride(
  "retry",
  {
    id: idArgument,
    deliveryId: Argument.String("delivery-id").pipe(
      Argument.withDescription("Webhook delivery id"),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    json: jsonFlag,
  },
  {
    mapInput: ({ id, deliveryId }) => ({ id, deliveryId }),
    call: (request) => Webhooks.retryDelivery(request),
    failure: "Could not retry webhook delivery",
    preview: {
      data: (request) => ({
        dryRun: true,
        action: "webhooks.retry",
        id: request.id,
        deliveryId: request.deliveryId,
      }),
      render: (request) =>
        Console.log(
          `[dry-run] Would retry delivery ${request.deliveryId} for webhook ${request.id}.`,
        ),
    },
    render: (data) =>
      printFields([
        ["Status", data.outcome === "succeeded" ? "Retried" : "Retry failed"],
        ["Accepted", data.accepted],
        ["Delivery", data.deliveryId],
        ["Attempt", data.attemptId],
        ["Outcome", data.outcome],
      ]),
  },
).pipe(
  Command.withDescription("Retry a failed webhook delivery"),
  Command.withExamples([{ command: "samva webhooks retry wep_abc123 whdel_abc123 --dry-run" }]),
);
const rotate = deriveOverride(
  "rotate-secret",
  {
    id: idArgument,
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
    json: jsonFlag,
  },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => Webhooks.regenerateSecret(request),
    failure: "Could not rotate webhook secret",
    preview: {
      data: (request) => ({ dryRun: true, action: "webhooks.rotate-secret", id: request.id }),
      render: (request) =>
        Console.log(`[dry-run] Would rotate the signing secret for webhook ${request.id}.`),
    },
    confirmation: (request) => ({
      message: `Rotate the signing secret for webhook ${request.id}? The previous secret keeps verifying for 24 hours.`,
      nonInteractiveMessage:
        "Secret rotation requires --yes in non-interactive mode. Preview with --dry-run.",
    }),
    mapOutput: (data, _input, request) => ({
      secret: Redacted.value(data.secret),
      warning: `Read this signing secret again with samva webhooks secret ${request.id}. The previous secret remains valid for 24 hours.`,
    }),
    render: (data, _input, request) =>
      Effect.gen(function* () {
        const warning = `Read this signing secret again with samva webhooks secret ${request.id}. The previous secret remains valid for 24 hours.`;
        yield* Console.error(`WARNING: ${warning}`);
        yield* Console.log(Redacted.value(data.secret));
      }),
  },
).pipe(
  Command.withDescription("Rotate a webhook signing secret"),
  Command.withExamples([
    { command: "samva webhooks rotate-secret wep_abc123 --dry-run" },
    { command: "samva webhooks rotate-secret wep_abc123 --yes --json" },
  ]),
);

const create = deriveOverride(
  "create",
  {
    data: Flag.String("data").pipe(
      Flag.withDescription("Webhook JSON: name, url, eventTypes, and optional retry settings"),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    json: jsonFlag,
  },
  {
    prepare: ({ data }) => decodePayload(data, "--data", Webhooks.CreatePayload),
    call: (request) => Webhooks.create(request),
    failure: "Could not create webhook",
    preview: {
      data: (request) => ({ dryRun: true, action: "webhooks.create", request }),
      render: (request) =>
        printFields([["Action", "webhooks.create"], ...objectRows(request, { explicit: true })]),
    },
    mapOutput: (result) => ({
      endpoint: result.endpoint,
      secret: Redacted.value(result.secret),
      warning: `Read this signing secret again with samva webhooks secret ${result.endpoint.id}.`,
    }),
    render: (result) =>
      Effect.gen(function* () {
        const warning = `Read this signing secret again with samva webhooks secret ${result.endpoint.id}.`;
        yield* Console.error(`WARNING: ${warning}`);
        yield* printFields([
          ["ID", result.endpoint.id],
          ["Name", result.endpoint.name],
          ["Status", result.endpoint.status],
          ["URL", result.endpoint.url],
          ["Signing secret", Redacted.value(result.secret)],
        ]);
      }),
  },
).pipe(
  Command.withDescription("Create a customer webhook from JSON"),
  Command.withExamples([
    {
      command: `samva webhooks create --data '{"name":"delivery","url":"https://example.com/hook","eventTypes":["message.delivered"]}' --dry-run`,
    },
  ]),
);

const update = deriveOverride(
  "update",
  {
    id: idArgument,
    data: Flag.String("data").pipe(Flag.withDescription("JSON object of webhook fields to update")),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    json: jsonFlag,
  },
  {
    prepare: ({ id, data }) =>
      decodePayload(data, "--data", Webhooks.UpdatePayload).pipe(
        Effect.map((payload) => ({ id, ...payload })),
      ),
    call: (request) => Webhooks.update(request),
    failure: "Could not update webhook",
    preview: {
      data: (request) => {
        const { id, ...payload } = request;
        return { dryRun: true, action: "webhooks.update", id, request: payload };
      },
      render: (request) => {
        const { id, ...payload } = request;
        return printFields([
          ["Action", "webhooks.update"],
          ["Webhook", id],
          ...objectRows(payload, { explicit: true }),
        ]);
      },
    },
    render: (result) => printFields(objectRows(result)),
  },
).pipe(
  Command.withDescription("Update a customer webhook from JSON"),
  Command.withExamples([
    {
      command: `samva webhooks update wep_abc123 --data '{"url":"https://example.com/new"}' --dry-run`,
    },
  ]),
);

const remove = deriveOverride(
  "remove",
  {
    id: idArgument,
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
    json: jsonFlag,
  },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => Webhooks.remove(request),
    failure: "Could not remove webhook",
    preview: {
      data: (request) => ({ dryRun: true, action: "webhooks.remove", id: request.id }),
      render: (request) => Console.log(`[dry-run] Would permanently remove webhook ${request.id}.`),
    },
    confirmation: (request) => ({
      message: `Permanently remove webhook ${request.id}?`,
      nonInteractiveMessage:
        "Permanent webhook deletion requires --yes in non-interactive mode. Preview with --dry-run.",
    }),
    render: (_result, _input, request) => Console.log(`Removed webhook ${request.id}.`),
  },
).pipe(
  Command.withDescription("Permanently delete a customer webhook"),
  Command.withExamples([
    { command: "samva webhooks remove wep_abc123 --dry-run" },
    { command: "samva webhooks remove wep_abc123 --yes" },
  ]),
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
