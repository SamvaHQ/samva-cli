import { MailboxId } from "@samva/core/shared/base";
import { Config, Effect, Option, Stream } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import * as Mailboxes from "samva/effect/mailboxes";

import { apiErrorGuidance, CliUsageError, SamvaCliError } from "../errors";
import { getClientProvider } from "../lib/client";
import { printJsonLine, warningEnvelope, writeOutput } from "../lib/output";
import { commandNameFromArgv, type OutputMode, outputModeFromArgv } from "../lib/runtime";

type StreamFailure = Stream.Error<ReturnType<typeof Mailboxes.events>>;
type StreamError = CliUsageError | SamvaCliError;

const refusalNext = (failure: StreamFailure): string => {
  switch (failure._tag) {
    case "UnauthorizedError":
      return "Run samva login, or set SAMVA_API_KEY to an active key.";
    case "ForbiddenError":
      return "Use a credential that may read mailboxes and follow the API message.";
    case "ResourceNotFoundError":
      return "Run samva mailboxes list to find the mailboxes this credential can read, then retry with those mailbox ids.";
    case "CursorExpiredError":
      return "Events after your cursor expired. Read current state from the API and reconnect without --cursor.";
    case "ValidationError":
      return "Fix the listed fields before retrying; pass --cursor only as an event frame printed it.";
    case "RateLimitedError":
    case "ServiceUnavailableError":
      return failure.retryAfterSeconds === undefined
        ? "Wait before reconnecting."
        : `Wait ${failure.retryAfterSeconds} seconds before reconnecting.`;
    case "MethodNotAllowedError":
    case "UpgradeRequiredError":
      return "Check SAMVA_EVENTS_URL points at the Samva events origin.";
    default:
      return `Reconnect${failure.cursor === undefined ? "" : ` with --cursor ${failure.cursor}`}; if it still fails, run samva feedback send and name the command.`;
  }
};

/**
 * The SDK stream's failure as CLI guidance. A refusal or close that names an API error carries
 * that tag, its status, and its public fields into the JSON envelope, so 401 and 403 exit 4 as for
 * any API call.
 */
export const streamError = (failure: StreamFailure): StreamError => {
  const resume = failure.cursor === undefined ? "" : ` with --cursor ${failure.cursor}`;
  if (failure._tag === "StreamClientError") {
    return new CliUsageError({
      code: "mailbox_events_invalid_request",
      message:
        failure.closeCode === undefined
          ? failure.message.replaceAll("`eventsUrl`", "SAMVA_EVENTS_URL")
          : `Mailbox event stream ended (${failure.closeCode}). Check the cursor, mailbox filters, and acknowledgement frames.`,
    });
  }
  if (failure.status === 400) {
    return new CliUsageError({
      code: "mailbox_events_invalid_request",
      message: `Mailbox event stream refused (400): ${failure.message} Check the cursor and mailbox filters.`,
    });
  }
  if (failure._tag === "StreamProtocolError")
    return new SamvaCliError({ message: `Invalid mailbox event frame: ${failure.message}` });
  const details = {
    ...(failure.fields === undefined ? {} : { fields: failure.fields }),
    ...(failure.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: failure.retryAfterSeconds }),
  };
  const guidance = apiErrorGuidance({ _tag: failure._tag, ...details });
  const status = failure.status ?? guidance?.status;
  const reconnectHint = failure._tag === "StreamDisconnectedError" ? ` Reconnect${resume}.` : "";
  const message = (() => {
    if (failure.status !== undefined)
      return `Mailbox event stream refused (${failure.status}): ${failure.message}`;
    if (failure.closeCode === undefined) return `${failure.message}${reconnectHint}`;
    if (failure.closeCode === 4408)
      return `Mailbox event stream ended (4408). Acknowledgement window full. Reconnect${resume || " with --cursor <last cursor>"}.`;
    return `Mailbox event stream ended (${failure.closeCode}). ${failure.message}${reconnectHint}`;
  })();
  if (status === undefined) return new SamvaCliError({ message });
  return new SamvaCliError({
    message,
    api: {
      reason: failure.serverTag ?? failure._tag,
      status,
      // Machine modes keep stderr one JSON diagnostic: the cursor rides in its details.
      details: failure.cursor === undefined ? details : { ...details, lastCursor: failure.cursor },
      next: refusalNext(failure),
    },
  });
};

/**
 * Stop the stream on Ctrl+C. The streaming command owns the signal: `runMain` otherwise
 * interrupts it with exit 130.
 */
const untilInterrupted = <A, E, R>(
  run: (interrupted: Effect.Effect<void>) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.rawListeners("SIGINT");
      for (const handler of previous) process.off("SIGINT", handler);
      return previous;
    }),
    () =>
      run(
        Effect.callback<void>((resume) => {
          const handler = () => resume(Effect.void);
          process.once("SIGINT", handler);
          return Effect.sync(() => process.off("SIGINT", handler));
        }),
      ),
    (previous) =>
      Effect.sync(() => {
        for (const handler of previous) process.on("SIGINT", handler);
      }),
  );

/** How long Ctrl+C waits for an event handler that is still running before it stops anyway. */
const HANDLER_DRAIN = "2 seconds";

export interface TailEventsOptions {
  readonly cursor?: string | undefined;
  readonly mailboxIds: ReadonlyArray<string>;
  readonly limit?: number | undefined;
  /**
   * Human mode prints the live line, each reconnect, and the last cursor to stderr. `jsonl` writes
   * each reconnect to stderr as a warning envelope; `quiet` and `json` print neither.
   */
  readonly output: OutputMode;
  /** Resume from the last handled cursor after a transient drop. Defaults to `true`. */
  readonly reconnect?: boolean | undefined;
  /** Handles one event; the stream acknowledges it once this succeeds and the next is pulled. */
  readonly onEvent: (event: Mailboxes.MailboxEvent) => Effect.Effect<void, StreamError>;
}

/** What ended the connection, in a few words for a reconnect line. */
const dropCause = (error: Mailboxes.MailboxEventStreamError): string => {
  if (error.closeCode !== undefined) return `closed with ${error.closeCode}`;
  if (error.status !== undefined) return `refused with ${error.status}`;
  if (error.reason === "idleTimeout") return "no frames from the events host";
  return "host unreachable";
};

const reconnectNotice = (
  output: OutputMode,
  reconnect: Mailboxes.MailboxEventStreamReconnect,
): string | undefined => {
  const seconds = Math.max(0.1, Math.round(reconnect.delayMillis / 100) / 10);
  const resume = reconnect.cursor === undefined ? "live" : `from cursor ${reconnect.cursor}`;
  if (output === "human")
    return `Mailbox event stream dropped (${dropCause(reconnect.error)}). Reconnecting ${resume} in ${seconds}s (attempt ${reconnect.attempt}).\n`;
  if (output === "jsonl")
    return `${JSON.stringify(
      warningEnvelope(
        commandNameFromArgv(process.argv.slice(2)),
        "mailbox_events_reconnecting",
        `Mailbox event stream dropped (${dropCause(reconnect.error)}). Reconnecting ${resume}.`,
        {
          errorTag: reconnect.error._tag,
          closeCode: reconnect.error.closeCode,
          status: reconnect.error.status,
          idleTimeout: reconnect.error.reason === "idleTimeout" ? true : undefined,
          cursor: reconnect.cursor,
          attempt: reconnect.attempt,
          retryInMillis: Math.round(reconnect.delayMillis),
        },
      ),
    )}\n`;
  return undefined;
};

/**
 * Tail the mailbox event stream through the SDK. A transient drop reconnects from the last handled
 * cursor, so events can repeat but are not lost. With `reconnect: false` the drop ends the command
 * with the last cursor, for a scripted caller that decides itself.
 */
export const tailEvents = (options: TailEventsOptions) =>
  Effect.gen(function* () {
    const provider = yield* getClientProvider;
    const override = yield* Config.option(Config.String("SAMVA_EVENTS_URL"));
    const eventsUrl = Option.getOrUndefined(override);
    yield* untilInterrupted((interrupted) =>
      provider.provide(
        Mailboxes.events({
          cursor: options.cursor,
          mailboxIds: options.mailboxIds,
          eventsUrl,
          reconnect: options.reconnect ?? true,
          onLive: () => {
            if (options.output === "human") process.stderr.write("Mailbox event stream is live.\n");
          },
          onReconnect: (reconnect) => {
            const notice = reconnectNotice(options.output, reconnect);
            if (notice !== undefined) process.stderr.write(notice);
          },
        }).pipe(
          Stream.tapError((failure) =>
            Effect.sync(() => {
              if (options.output === "human" && failure.cursor !== undefined)
                process.stderr.write(`Last cursor: ${failure.cursor}\n`);
            }),
          ),
          Stream.mapError(streamError),
          options.limit === undefined ? (stream) => stream : Stream.take(options.limit),
          Stream.interruptWhen(interrupted),
          Stream.runForEach(options.onEvent),
          // A handler still running at Ctrl+C gets a moment to finish; one that never returns must
          // not hold the stop hostage.
          Effect.raceFirst(interrupted.pipe(Effect.andThen(Effect.sleep(HANDLER_DRAIN)))),
        ),
      ),
    );
  });

export const mailboxesEventsCommand = Command.make("events", {
  mailbox: Argument.String("mailbox-id").pipe(
    Argument.withDescription(
      "Mailboxes to follow; omit to follow every mailbox the credential reads",
    ),
    Argument.withSchema(MailboxId),
    Argument.atLeast(0),
  ),
  cursor: Flag.String("cursor").pipe(
    Flag.withDescription("Replay events after a cursor from an earlier event frame, then go live"),
    Flag.optional,
  ),
  limit: Flag.Int("limit").pipe(Flag.optional),
  noReconnect: Flag.Boolean("no-reconnect").pipe(
    Flag.withDefault(false),
    Flag.withDescription(
      "Exit non-zero with the last cursor when the connection drops, instead of reconnecting from it",
    ),
  ),
}).pipe(
  Command.withDescription(
    "Tail mailbox events, one record per line; --jsonl wraps each in a result envelope; a dropped connection reconnects from the last cursor; Ctrl+C exits cleanly",
  ),
  Command.withExamples([
    { command: "samva mailboxes events mbx_1234567890123456 --limit 10" },
    {
      command: "samva mailboxes events mbx_1234567890123456 mbx_6543210987654321 --jsonl",
      description: "Follow several mailboxes",
    },
    { command: "samva mailboxes events --jsonl", description: "Stream envelopes for automation" },
    { command: "samva mailboxes events --cursor <cursor-from-an-event-frame>" },
    {
      command: "samva mailboxes events --jsonl --no-reconnect",
      description: "Exit non-zero on a dropped connection and decide yourself",
    },
  ]),
  Command.withHandler(({ cursor, mailbox, limit, noReconnect }) =>
    Effect.gen(function* () {
      const mode = outputModeFromArgv(process.argv.slice(2));
      // --json promises one bounded result, which a tail cannot buffer without losing
      // acknowledged events on a mid-stream failure.
      if (mode === "json")
        return yield* new CliUsageError({
          code: "events_requires_jsonl",
          message:
            "mailboxes events streams and cannot return one --json result. Use --jsonl to stream events, optionally with --limit N to stop after N.",
        });
      const count = Option.getOrUndefined(limit);
      if (count !== undefined && count <= 0)
        return yield* new CliUsageError({
          code: "invalid_events_limit",
          message: "--limit must be a positive integer.",
        });
      yield* tailEvents({
        cursor: Option.getOrUndefined(cursor),
        mailboxIds: mailbox,
        limit: count,
        output: mode,
        reconnect: !noReconnect,
        onEvent: (event) => {
          const record = {
            cursor: event.cursor,
            id: event.id,
            event: { type: event.type, timestamp: event.timestamp, data: event.data },
          };
          // Quiet drops the record; the stream still acknowledges and counts the event.
          if (mode === "quiet") return Effect.void;
          return mode === "jsonl"
            ? printJsonLine(record)
            : writeOutput(process.stdout, `${JSON.stringify(record)}\n`);
        },
      });
    }),
  ),
);
