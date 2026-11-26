import { matchesLogFilters } from "@samva/contracts/developer/log-stream";
import { LogDetailId, LogListQuery } from "@samva/contracts/developer/logs-group";
import { logQueryFromTokens, parseLogTime } from "@samva/core/messages/log-filters";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "@samva/core/shared/cursor";
import { Clock, Console, Effect, Option, Schema, Stream } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import * as Logs from "samva/effect/logs";

import { eventsUrlConfig } from "../config/events";
import { CliUsageError, toCliApiError } from "../errors";
import { getClientProvider } from "../lib/client";
import { writeOutput } from "../lib/output";
import { Json, JsonLines, Quiet } from "../lib/runtime";

type Line = Effect.Success<ReturnType<typeof Logs.list>>["items"][number];

const safeColumn = (value: string): string =>
  // oxlint-disable-next-line no-control-regex -- Keep untrusted subjects and addresses off terminal control sequences and extra output lines.
  value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");

const EVENT_COLOR: Partial<Record<Line["event"], number>> = {
  rejected: 31,
  failed: 31,
  bounced: 31,
  waiting: 33,
  delivered: 32,
  received: 32,
};

const displayTime = (date: Date, tty: boolean, utc: boolean): string => {
  if (!tty || utc) return date.toISOString();
  const offset = -date.getTimezoneOffset();
  const minutes = Math.abs(offset);
  const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
  const remainder = String(minutes % 60).padStart(2, "0");
  const local = new Date(date.getTime() + offset * 60_000).toISOString();
  return `${local.slice(0, -1).replace("T", " ")} ${offset < 0 ? "-" : "+"}${hours}:${remainder}`;
};

const utcFlag = Flag.Boolean("utc").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Show terminal timestamps in UTC"),
);

export const formatLogLine = (line: Line, tty: boolean, color: boolean, utc = false): string => {
  const timestamp = displayTime(new Date(line.timestamp), tty, utc);
  const event = tty ? line.event.padEnd(12) : line.event;
  const colorCode = EVENT_COLOR[line.event] ?? 36;
  const channel = line.channel ?? "-";
  const address = line.direction === "inbound" ? line.from?.address : line.recipient;
  const subject = line.subject === null ? null : JSON.stringify(safeColumn(line.subject));
  const reason = line.event === "rejected" ? line.errorTag : line.reason;
  const request = line.event === "rejected" || !tty ? line.requestId : null;
  return [
    timestamp,
    tty && color ? `\u001b[${colorCode}m${event}\u001b[0m` : event,
    tty ? channel.padEnd(8) : channel,
    line.messageId ?? line.id,
    reason === null ? null : safeColumn(reason),
    request === null ? null : safeColumn(request),
    address === undefined || address === null
      ? null
      : `${line.direction === "inbound" ? "←" : "→"} ${safeColumn(address)}`,
    subject,
  ]
    .filter((value) => !tty || value !== null)
    .join(tty ? "  " : "\t");
};

const usage = (message: string) => new CliUsageError({ code: "invalid_log_filters", message });

const timeBound = (input: Option.Option<string>, flag: string, now: number) =>
  Option.match(input, {
    onNone: () => Effect.undefined,
    onSome: (value) => {
      const time = parseLogTime(value, now);
      return time === null
        ? Effect.fail(
            usage(
              `Invalid ${flag} value. Use a duration such as 30m, a date, or an ISO timestamp.`,
            ),
          )
        : Effect.succeed(new Date(time).toISOString());
    },
  });

const show = Command.make("show", {
  id: Argument.String("id").pipe(Argument.withSchema(LogDetailId)),
  utc: utcFlag,
}).pipe(
  Command.withDescription(
    "Show a message timeline or rejected submission by message, rejection, or request ID.",
  ),
  Command.withExamples([{ command: "samva logs show req_86c0d92e-2b8a-4139-a13a-9a90fe00c1ee" }]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, utc }) {
      const provider = yield* getClientProvider;
      const detail = yield* provider
        .provide(Logs.get({ id }))
        .pipe(Effect.mapError((error) => toCliApiError("Could not read log detail", error)));
      if (yield* Quiet) return;
      const json = yield* Json;
      const jsonl = yield* JsonLines;
      if (json) return yield* Console.log(JSON.stringify(detail));
      if (jsonl) return yield* writeOutput(process.stdout, `${JSON.stringify(detail)}\n`);
      const heading =
        detail.kind === "message"
          ? [
              detail.messageId,
              ...detail.statusTimeline.entries.map(({ at, status, reason }) =>
                [at, status, reason]
                  .filter((part) => part !== null)
                  .map(safeColumn)
                  .join("  "),
              ),
            ]
          : [
              formatLogLine(detail.line, Boolean(process.stdout.isTTY), Bun.enableANSIColors, utc),
              safeColumn(detail.line.reason ?? ""),
            ];
      const sections = [
        ["Request", detail.apiRequest === null ? null : JSON.stringify(detail.apiRequest, null, 2)],
        ["Request body", detail.requestBody],
        ["Response body", detail.responseBody],
        ["Content", detail.kind === "message" ? JSON.stringify(detail.content, null, 2) : null],
      ].flatMap(([title, value]) =>
        value === null ? [] : [`\n${title}\n${value?.split("\n").map(safeColumn).join("\n")}`],
      );
      yield* writeOutput(process.stdout, [...heading, ...sections].join("\n") + "\n");
    }),
  ),
);

export const logsCommand = Command.make("logs", {
  tokens: Argument.String("filter").pipe(
    Argument.atLeast(0),
    Argument.withDescription("Filters such as status:failed, channel:email, or msg:<id>"),
  ),
  lines: Flag.Int("lines").pipe(
    Flag.withAlias("n"),
    Flag.optional,
    Flag.withDescription("Number of event lines to print (default 20)"),
  ),
  follow: Flag.Boolean("follow").pipe(
    Flag.withDefault(false),
    Flag.withAlias("f"),
    Flag.withDescription("Print recent lines and follow new events until Ctrl+C"),
  ),
  all: Flag.Boolean("all").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Print all matching events in the plan window"),
  ),
  since: Flag.String("since").pipe(
    Flag.optional,
    Flag.withDescription("Start time, e.g. 1h, yesterday, or an ISO time"),
  ),
  until: Flag.String("until").pipe(
    Flag.optional,
    Flag.withDescription("End time, e.g. 30m, a date, or an ISO time"),
  ),
  reverse: Flag.Boolean("reverse").pipe(
    Flag.withAlias("r"),
    Flag.withDefault(false),
    Flag.withDescription("Print newest events first"),
  ),
  utc: utcFlag,
  after: Flag.String("after").pipe(
    Flag.optional,
    Flag.withDescription("Resume from an event's cursor"),
  ),
}).pipe(
  Command.withDescription("Read the organization's message event log."),
  Command.withExamples([
    { command: "samva logs status:failed --since 1h" },
    { command: "samva logs -f status:failed --jsonl" },
    { command: "samva logs --jsonl | jq 'select(.event==\"bounced\")'" },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* (input) {
      const json = yield* Json;
      if (json && input.follow)
        return yield* usage(
          "--json cannot be combined with --follow. Use --jsonl to stream event lines.",
        );
      const now = yield* Clock.currentTimeMillis;
      const { query, invalid } = logQueryFromTokens(input.tokens.join(" "), now);
      if (invalid.length > 0)
        return yield* usage(
          `Invalid log filter: ${JSON.stringify(invalid.join(", "))}. Run samva logs --help.`,
        );
      const lines = Option.getOrUndefined(input.lines);
      if (lines !== undefined && (!Number.isSafeInteger(lines) || lines <= 0))
        return yield* usage("--lines must be a positive integer.");
      if (input.all && lines !== undefined) return yield* usage("Choose either --all or --lines.");

      const after = Option.getOrUndefined(input.after);
      const since = (yield* timeBound(input.since, "--since", now)) ?? query.since;
      const until = (yield* timeBound(input.until, "--until", now)) ?? query.until;
      const filters = yield* Schema.decodeUnknownEffect(LogListQuery)({
        ...query,
        since,
        until,
        after,
      }).pipe(Effect.mapError((error) => usage(error.message)));
      if (
        filters.since !== undefined &&
        filters.until !== undefined &&
        filters.since > filters.until
      )
        return yield* usage("The start of the log window must be at or before the end.");

      const provider = yield* getClientProvider;
      const reversePage = !input.reverse && !input.all && after === undefined;
      const order = after !== undefined || (!input.reverse && input.all) ? "asc" : "desc";
      const count = lines ?? DEFAULT_PAGE_LIMIT;
      const pages = Stream.paginate(after, (position) =>
        provider
          .provide(
            Logs.list({
              ...filters,
              cursor: undefined,
              after: position,
              order,
              orderBy: after === undefined ? "timestamp" : "recorded",
              limit: input.all ? MAX_PAGE_LIMIT : Math.min(count, MAX_PAGE_LIMIT),
            }),
          )
          .pipe(
            Effect.mapBoth({
              onSuccess: ({ items, nextCursor }) =>
                [items, Option.fromNullishOr(nextCursor)] as const,
              onFailure: (error) => toCliApiError("Could not read logs", error),
            }),
          ),
      );
      const items = input.all ? pages : Stream.take(pages, count);
      const needsReverse = reversePage || (input.reverse && after !== undefined);
      const ordered = needsReverse
        ? Stream.unwrap(
            Stream.runCollect(items).pipe(
              Effect.map((rows) => Stream.fromIterable([...rows].reverse())),
            ),
          )
        : items;
      const quiet = yield* Quiet;
      const jsonl = yield* JsonLines;
      const tty = Boolean(process.stdout.isTTY);
      const color = tty && Bun.enableANSIColors;
      const write = (line: Line) =>
        quiet
          ? Effect.void
          : writeOutput(
              process.stdout,
              `${jsonl ? JSON.stringify(line) : formatLogLine(line, tty, color, input.utc)}\n`,
            );
      if (input.follow) {
        const eventsUrl = Option.getOrUndefined(yield* eventsUrlConfig);
        const cursor = yield* provider
          .provide(Logs.streamCursor({ eventsUrl }))
          .pipe(
            Effect.mapError((error) =>
              toCliApiError("Could not open the message log stream", error),
            ),
          );
        const printed = new Set<string>();
        const writeRecent = (line: Line) => {
          if (!quiet) printed.add(line.id);
          return write(line);
        };
        yield* Stream.runForEach(ordered, writeRecent);
        let announced = false;
        return yield* provider.provide(
          Logs.events({
            cursor,
            eventsUrl,
            onLive: () => {
              if (!announced && !quiet && !jsonl) {
                announced = true;
                process.stderr.write("Message log stream is live.\n");
              }
            },
            onReconnect: ({ cursor: resume }) => {
              if (!quiet && !jsonl)
                process.stderr.write(
                  `Reconnecting to the message log from cursor ${resume ?? cursor}.\n`,
                );
            },
          }).pipe(
            Stream.filter(
              (entry) => !printed.delete(entry.line.id) && matchesLogFilters(filters, entry),
            ),
            Stream.mapError((error) =>
              toCliApiError(
                error._tag === "CursorExpiredError"
                  ? "Log replay expired. Use --since to read older lines"
                  : "Message log stream ended",
                error,
              ),
            ),
            Stream.runForEach(({ line }) => write(line)),
          ),
        );
      }
      if (quiet) return yield* Stream.runDrain(items);
      if (json) {
        const rows = yield* Stream.runCollect(ordered);
        return yield* Console.log(JSON.stringify(rows));
      }
      yield* Stream.runForEach(ordered, write);
    }),
  ),
  Command.withSubcommands([show]),
);
