import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Messages from "samva/effect/messages";

import {
  apiErrorGuidance,
  CliMessageLifecycleError,
  CliUsageError,
  formatApiError,
  toCliApiError,
} from "../errors";
import { getClientProvider } from "../lib/client";
import { jsonFlag, printFields, printJson, printJsonLine } from "../lib/output";
import { isJsonLinesRequested } from "../lib/runtime";

type Message = Effect.Success<ReturnType<typeof Messages.get>>;
type MessageReceipt = Effect.Success<ReturnType<typeof Messages.send>>;
type MessageDelivery = Effect.Success<ReturnType<typeof Messages.listDeliveries>>["items"][number];
type MessageSummary = Effect.Success<ReturnType<typeof Messages.list>>["items"][number];

/** A message read back with its deliveries, the facts its lifecycle is decided from. */
export interface MessageReading {
  readonly message: Message;
  readonly deliveries: ReadonlyArray<MessageDelivery>;
}

/** What the CLI last saw of a message: the send receipt, or a reading. */
export type MessageObservation = MessageReceipt | MessageReading;

const isReading = (observation: MessageObservation): observation is MessageReading =>
  "message" in observation;

export interface MessageProjection {
  readonly id: string;
  readonly status: string;
  /**
   * Why a queued message waits; null when nothing holds it. `screening-unavailable` waits for
   * Samva's content check to recover; `content-review` needs a decision.
   */
  readonly waitReason: string | null;
  /** When Samva expects to decide a content review; null unless `waitReason` is `content-review`. */
  readonly reviewExpectedAt: string | null;
  readonly createdAt: string;
  readonly skippedRecipients: MessageReceipt["skippedRecipients"];
}

export interface MessageReadingProjection extends MessageProjection {
  readonly channel: string;
  /** The sending address of an email; null for other channels. */
  readonly from: string | null;
  readonly conversationId: string | null;
  readonly updatedAt: string;
  readonly deliveries: ReadonlyArray<{
    readonly status: string;
    readonly recipient: string | null;
  }>;
}

/**
 * The deliberately small Message shape shared by send, get, and wait. A bare receipt carries only
 * what the send accepted; a reading adds the sender, conversation, and per-recipient status.
 */
export function projectMessage(observation: MessageReading): MessageReadingProjection;
export function projectMessage(observation: MessageObservation): MessageProjection;
export function projectMessage(
  observation: MessageObservation,
): MessageProjection | MessageReadingProjection {
  if (!isReading(observation)) {
    return {
      id: observation.id,
      status: observation.status,
      waitReason: observation.waitReason,
      reviewExpectedAt: observation.reviewExpectedAt,
      createdAt: observation.createdAt,
      skippedRecipients: observation.skippedRecipients,
    };
  }
  const { message, deliveries } = observation;
  return {
    id: message.id,
    status: message.status,
    waitReason: message.waitReason,
    reviewExpectedAt: message.reviewExpectedAt,
    createdAt: message.createdAt,
    skippedRecipients: message.skippedRecipients,
    channel: message.channel,
    from: message.from?.address ?? null,
    conversationId: message.conversationId,
    updatedAt: message.updatedAt,
    deliveries: deliveries.map((delivery) => ({
      status: delivery.status,
      recipient: delivery.recipient,
    })),
  };
}

/** The human `Waiting` line: the wait reason in words, with the review time when there is one. */
export const waitingLine = (
  message: Pick<MessageProjection, "waitReason" | "reviewExpectedAt">,
): string | null => {
  if (message.waitReason === null) return null;
  const reason = message.waitReason.replaceAll("-", " ");
  return message.reviewExpectedAt === null
    ? reason
    : `${reason} (expected by ${message.reviewExpectedAt})`;
};

export const skippedRecipientsLine = (message: {
  readonly skippedRecipients: ReadonlyArray<{
    readonly address: string;
    readonly reason: string;
    readonly topicId?: string | null | undefined;
  }>;
}): string | null =>
  message.skippedRecipients.length === 0
    ? null
    : message.skippedRecipients
        .map(
          (recipient) =>
            `${recipient.address} (${recipient.reason}${recipient.topicId == null ? "" : `, topic ${recipient.topicId}`})`,
        )
        .join("; ");

const printMessage = (message: MessageReadingProjection) =>
  printFields([
    ["Message ID", message.id],
    ["Channel", message.channel],
    ["Status", message.status],
    ["From", message.from],
    ["Waiting", waitingLine(message)],
    ["Skipped", skippedRecipientsLine(message)],
    ["Conversation", message.conversationId],
    ["Created", message.createdAt],
    ["Updated", message.updatedAt],
  ]);

const printSummary = (message: MessageSummary) =>
  printFields([
    ["Message ID", message.id],
    ["Channel", message.channel],
    ["Direction", message.direction],
    ["Status", message.status],
    ["From", message.from],
    ["To", message.to.join(", ")],
    ["Subject", message.subject],
    ["Waiting", message.waitReason?.replaceAll("-", " ") ?? null],
    ["Created", message.createdAt],
  ]);

type MessageLifecycleSnapshot = {
  readonly status: string;
  readonly deliveries: ReadonlyArray<{ readonly status: string }>;
};

export const classifyMessageLifecycle = (message: MessageLifecycleSnapshot) => {
  const failed = (status: string) =>
    status === "failed" || status === "bounced" || status === "complained";
  const succeeded = (status: string) => status === "delivered" || status === "read";
  const messageStatus = message.status.toLowerCase();
  const deliveryStatuses = message.deliveries.map((delivery) => delivery.status.toLowerCase());
  if (failed(messageStatus) || deliveryStatuses.some(failed)) return "failure";
  if (
    succeeded(messageStatus) ||
    (deliveryStatuses.length > 0 && deliveryStatuses.every(succeeded))
  ) {
    return "success";
  }
  return "pending";
};

/** The lifecycle of an observation; a receipt is judged by its status alone. */
export const lifecycleOf = (observation: MessageObservation) =>
  classifyMessageLifecycle(
    isReading(observation)
      ? { status: observation.message.status, deliveries: observation.deliveries }
      : { status: observation.status, deliveries: [] },
  );

class MessageStillPending extends Schema.TaggedError<MessageStillPending>()("MessageStillPending", {
  message: Schema.String,
}) {}

export const messageLifecycleError = (
  code: string,
  message: string,
  partialMessage: MessageProjection,
  apiError?: unknown,
) =>
  new CliMessageLifecycleError({
    code,
    message,
    partialMessage,
    api: apiErrorGuidance(apiError),
    next: `samva messages wait ${partialMessage.id}`,
    human: [
      `Message ID    ${partialMessage.id}`,
      `Status        ${partialMessage.status}`,
      ...(waitingLine(partialMessage) === null
        ? []
        : [`Waiting       ${waitingLine(partialMessage)}`]),
      ...(skippedRecipientsLine(partialMessage) === null
        ? []
        : [`Skipped       ${skippedRecipientsLine(partialMessage)}`]),
      `Next          samva messages wait ${partialMessage.id}`,
    ].join("\n"),
  });

/** Default wait budget applied when --timeout is omitted. */
export const DEFAULT_TIMEOUT = "2m";

/**
 * `--timeout` is modelled as an optional flag rather than one with a baked-in
 * default so `Option.isSome` tells callers whether the user actually passed it.
 * The parser owns detection, so a flag *value* of `--timeout` (e.g.
 * `--subject "--timeout"`) and a trailing `--` are not mistaken for the flag.
 */
export const timeoutFlag = Flag.String("timeout").pipe(
  Flag.withDescription("Maximum wait duration (default: 2m; only used with --wait)"),
  Flag.optional,
);

/** Duration.fromInput unit word for each `--timeout` compact-form suffix. */
const DURATION_UNIT_WORD_BY_SUFFIX: Record<string, string> = {
  ms: "millis",
  s: "seconds",
  m: "minutes",
};

export const durationFromFlag = (raw: string) => {
  const invalidTimeout = () =>
    Effect.fail(
      new CliUsageError({
        code: "invalid_timeout",
        message:
          '--timeout must be a positive duration, for example `--timeout 2m` or `--timeout "2 minutes"`.',
      }),
    );
  const compact = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/i.exec(raw);
  const value = compact
    ? `${compact[1]} ${DURATION_UNIT_WORD_BY_SUFFIX[compact[2]?.toLowerCase() ?? ""] ?? "hours"}`
    : raw;
  const isDurationInput = (input: string): input is `${number} ${Duration.Unit}` =>
    /^\d+(?:\.\d+)?\s+(?:nanos?|micros?|millis?|seconds?|minutes?|hours?)$/.test(input);
  if (!isDurationInput(value)) return invalidTimeout();
  return Option.match(Duration.fromInput(value), {
    onNone: invalidTimeout,
    onSome: (duration) =>
      Duration.isFinite(duration) && Duration.toMillis(duration) > 0
        ? Effect.succeed(duration)
        : invalidTimeout(),
  });
};

const apiError = (message: string) => (error: unknown) => toCliApiError(message, error);

const readMessage = (id: string) =>
  getClientProvider.pipe(
    Effect.flatMap((client) =>
      Effect.all(
        {
          message: Messages.get({ id }),
          deliveries: Messages.listDeliveries({ id }).pipe(Effect.map((page) => page.items)),
        },
        { concurrency: "unbounded" },
      ).pipe(client.provide, Effect.mapError(apiError("Could not get message"))),
    ),
  );

/** Poll with an owned Effect timeout; interruption cancels the active request/fiber. */
export const waitForMessage = <Initial extends MessageObservation>(
  initial: Initial,
  timeout: Duration.Duration,
) =>
  Effect.gen(function* () {
    let latest: Initial | MessageReading = initial;
    if (lifecycleOf(latest) !== "pending") return latest;
    const id = projectMessage(initial).id;

    const poll = Effect.gen(function* () {
      const reading = yield* readMessage(id);
      latest = reading;
      if (lifecycleOf(reading) === "pending") {
        return yield* new MessageStillPending({
          message: `Message ${id} is ${reading.message.status}.`,
        });
      }
      return reading;
    }).pipe(
      Effect.retry({
        schedule: Schedule.spaced("1 second"),
        while: (error) => error instanceof MessageStillPending,
      }),
    );

    const result = yield* poll.pipe(
      Effect.timeoutOption(timeout),
      Effect.catch((error) =>
        messageLifecycleError(
          "message_observation_failed",
          formatApiError(`Could not continue observing message ${id}`, error),
          projectMessage(latest),
          error,
        ),
      ),
    );
    return Option.getOrElse(result, (): Initial | MessageReading => latest);
  });

const lifecycleResult = (reading: MessageReading, timeout: Duration.Duration) =>
  Effect.gen(function* () {
    const result = yield* waitForMessage(reading, timeout);
    const resultTerminal = lifecycleOf(result);
    return { observation: result, resultTerminal, timedOut: resultTerminal === "pending" };
  });

const cursorFlag = Flag.String("cursor").pipe(
  Flag.withDescription("Resume after this nextCursor from a previous page"),
  Flag.optional,
);
const limitFlag = Flag.Int("limit").pipe(
  Flag.withDescription("Maximum messages per page"),
  Flag.optional,
);
const statusFlag = Flag.Literals("status", [
  "pending",
  "scheduled",
  "queued",
  "processing",
  "sent",
  "delivered",
  "read",
  "failed",
  "bounced",
  "complained",
]).pipe(Flag.withDescription("Filter by message status"), Flag.optional);
const channelFlag = Flag.Literals("channel", ["email"]).pipe(
  Flag.withDescription("Filter by channel"),
  Flag.optional,
);
const directionFlag = Flag.Literals("direction", ["outbound", "inbound"]).pipe(
  Flag.withDescription("Filter by direction: outbound (sent) or inbound (received)"),
  Flag.optional,
);
const conversationIdFlag = Flag.String("conversation-id").pipe(
  Flag.withDescription("Filter by conversation id"),
  Flag.optional,
);
const contactIdFlag = Flag.String("contact-id").pipe(
  Flag.withDescription("Filter by contact id"),
  Flag.optional,
);
const fromFlag = Flag.String("from").pipe(
  Flag.withDescription("Filter by sender address, matched whole and case-insensitively"),
  Flag.optional,
);
const afterFlag = Flag.String("after").pipe(
  Flag.withDescription("Only messages created after this ISO 8601 instant"),
  Flag.optional,
);
const beforeFlag = Flag.String("before").pipe(
  Flag.withDescription("Only messages created before this ISO 8601 instant"),
  Flag.optional,
);
const allFlag = Flag.Boolean("all").pipe(
  Flag.withDescription("Traverse every page (requires --jsonl)"),
  Flag.withDefault(false),
);

const list = Command.make("list", {
  cursor: cursorFlag,
  limit: limitFlag,
  status: statusFlag,
  channel: channelFlag,
  direction: directionFlag,
  conversationId: conversationIdFlag,
  contactId: contactIdFlag,
  from: fromFlag,
  after: afterFlag,
  before: beforeFlag,
  all: allFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List messages"),
  Command.withExamples([
    { command: "samva messages list --channel email --limit 25" },
    { command: "samva messages list --status failed --json" },
    { command: "samva messages list --direction inbound --channel email" },
    { command: "samva messages list --from billing@acme.test" },
    { command: "samva messages list --all --jsonl", description: "Stream every page as JSONL" },
  ]),
  Command.withHandler(
    ({
      cursor,
      limit,
      status,
      channel,
      direction,
      conversationId,
      contactId,
      from,
      after,
      before,
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
        const client = yield* getClientProvider;
        const query = {
          channel: Option.getOrUndefined(channel),
          direction: Option.getOrUndefined(direction),
          status: Option.getOrUndefined(status),
          conversationId: Option.getOrUndefined(conversationId),
          contactId: Option.getOrUndefined(contactId),
          from: Option.getOrUndefined(from),
          after: Option.getOrUndefined(after),
          before: Option.getOrUndefined(before),
          limit: Option.getOrUndefined(limit),
        };
        const listPage = (pageCursor: string | undefined) =>
          Messages.list({ ...query, cursor: pageCursor }).pipe(
            client.provide,
            Effect.mapError(apiError("Could not list messages")),
          );
        if (all) {
          let nextCursor = Option.getOrUndefined(cursor);
          for (;;) {
            const data = yield* listPage(nextCursor);
            for (const item of data.items) yield* printJsonLine(item);
            if (data.nextCursor === null) return;
            nextCursor = data.nextCursor;
          }
        }
        const data = yield* listPage(Option.getOrUndefined(cursor));
        if (isJsonLinesRequested()) {
          for (const item of data.items) yield* printJsonLine(item);
          return;
        }
        if (json) return yield* printJson(data);
        if (data.items.length === 0) return yield* Console.log("No messages found.");
        for (const message of data.items) {
          yield* printSummary(message);
          yield* Console.log("");
        }
        if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
      }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const get = Command.make("get", { id: Argument.String("id"), json: jsonFlag }).pipe(
  Command.withDescription("Get a message"),
  Command.withExamples([{ command: "samva messages get msg_abc123 --json" }]),
  Command.withHandler(({ id, json }) =>
    readMessage(id).pipe(
      Effect.flatMap((reading) =>
        json ? printJson(projectMessage(reading)) : printMessage(projectMessage(reading)),
      ),
      (effect) =>
        json ? effect.pipe(Effect.provideService(References.MinimumLogLevel, "None")) : effect,
    ),
  ),
);

const events = Command.make("events", {
  id: Argument.String("id"),
  cursor: cursorFlag,
  limit: Flag.Int("limit").pipe(Flag.withDescription("Maximum events per page"), Flag.optional),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List lifecycle events for a message, oldest first"),
  Command.withExamples([{ command: "samva messages events msg_abc123 --json" }]),
  Command.withHandler(({ id, cursor, limit, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Messages.getEvents({
        id,
        cursor: Option.getOrUndefined(cursor),
        limit: Option.getOrUndefined(limit),
      }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not list message events", error)),
      );
      if (json) return yield* printJson(data);
      for (const event of data.items)
        yield* printFields([
          ["Event", event.eventType],
          ["Status", event.status],
          ["Time", event.timestamp],
        ]);
      if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const wait = Command.make("wait", {
  id: Argument.String("id"),
  timeout: timeoutFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Wait for a message to be delivered or read"),
  Command.withExamples([
    { command: "samva messages wait msg_abc123" },
    { command: "samva messages wait msg_abc123 --timeout 30s --json" },
  ]),
  Command.withHandler(({ id, timeout, json }) =>
    Effect.gen(function* () {
      const duration = yield* durationFromFlag(Option.getOrElse(timeout, () => DEFAULT_TIMEOUT));
      const initial = yield* readMessage(id);
      const result = yield* lifecycleResult(initial, duration);
      const projection = projectMessage(result.observation);
      if (result.timedOut) {
        return yield* messageLifecycleError(
          "message_wait_timeout",
          `Timed out waiting for message ${projection.id}; it remains ${projection.status}.`,
          projection,
        );
      }
      if (result.resultTerminal === "failure") {
        return yield* messageLifecycleError(
          "message_terminal_failure",
          `Message ${projection.id} reached terminal status ${projection.status}.`,
          projection,
        );
      }
      if (json) return yield* printJson(projection);
      yield* printMessage(projection);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

export const messagesCommand = Command.make("messages").pipe(
  Command.withDescription("Inspect messages and their lifecycle"),
  Command.withExamples([{ command: "samva messages list --channel email --json" }]),
  Command.withSubcommands([list, get, events, wait]),
);
