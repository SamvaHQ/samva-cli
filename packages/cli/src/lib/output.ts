import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { apiErrorGuidance, processErrorNext, processErrorReason, SamvaCliError } from "../errors";
import { commandNameFromArgv, isJsonLinesRequested, isJsonRequested } from "./runtime";

const CLI_SCHEMA_VERSION = 1 as const;

/** Await the write callback so piped output is complete before the command exits. */
export const writeOutput = (
  stream: NodeJS.WriteStream,
  text: string | Uint8Array,
): Effect.Effect<void, SamvaCliError> =>
  Effect.callback((resume) => {
    const onError = (error: Error) =>
      resume(
        Effect.fail(new SamvaCliError({ message: `Could not write CLI output: ${error.message}` })),
      );
    stream.once("error", onError);
    stream.write(text, (error) => {
      if (error) return onError(error);
      stream.removeListener("error", onError);
      resume(Effect.void);
    });
  });

export interface CliResultEnvelope {
  readonly schemaVersion: typeof CLI_SCHEMA_VERSION;
  readonly type: "result";
  readonly command: string;
  readonly data: unknown;
  readonly partial?: true | undefined;
}

export interface CliErrorEnvelope {
  readonly schemaVersion: typeof CLI_SCHEMA_VERSION;
  readonly type: "error";
  readonly command: string;
  readonly reason: string;
  readonly message: string;
  readonly status?: number | undefined;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
  readonly next?: string | undefined;
}

export const resultEnvelope = (
  command: string,
  data: unknown,
  partial?: true,
): CliResultEnvelope => ({
  schemaVersion: CLI_SCHEMA_VERSION,
  type: "result",
  command,
  data,
  partial,
});

export interface CliWarningEnvelope {
  readonly schemaVersion: typeof CLI_SCHEMA_VERSION;
  readonly type: "warning";
  readonly command: string;
  readonly reason: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * A non-fatal diagnostic for stderr: the command keeps running and its exit code is unchanged. In
 * a stream it is a line between records, never a stdout record.
 */
export const warningEnvelope = (
  command: string,
  reason: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): CliWarningEnvelope => ({
  schemaVersion: CLI_SCHEMA_VERSION,
  type: "warning",
  command,
  reason,
  message,
  details,
});

const errorEnvelope = (error: unknown, command: string, message: string): CliErrorEnvelope => ({
  schemaVersion: CLI_SCHEMA_VERSION,
  type: "error",
  command,
  reason: processErrorReason(error),
  status: apiErrorGuidance(error)?.status,
  details:
    error instanceof SamvaCliError && error.details !== undefined
      ? { ...apiErrorGuidance(error)?.details, ...error.details }
      : apiErrorGuidance(error)?.details,
  message,
  next: processErrorNext(error),
});

/**
 * Shared `--json` flag for read commands. Hidden from help because the global
 * `--json` (see {@link Json} in lib/runtime) already documents it — otherwise it
 * lists twice, e.g. `samva org current --help`. Parsing behavior is unchanged.
 */
export const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDefault(isJsonRequested() || isJsonLinesRequested()),
  Flag.withDescription("Output machine-readable JSON instead of formatted text"),
  Flag.withHidden,
);

const printJsonValue = (value: unknown) => {
  if (isJsonLinesRequested()) {
    // JSONL is a stream, not a buffered JSON document. Each record becomes a
    // complete envelope before it reaches stdout, so prior durable records
    // survive a later page or lifecycle failure.
    return writeOutput(
      process.stdout,
      `${JSON.stringify(resultEnvelope(commandNameFromArgv(process.argv.slice(2)), value))}\n`,
    );
  }
  return Console.log(JSON.stringify(value, null, 2));
};

/**
 * Print a machine result as pretty-printed JSON. Human mode is formatted text, so a handler
 * that reaches this without `--json` or `--jsonl` has a human path that prints a bare JSON
 * document: it fails loudly instead. A command whose human output is JSON by design calls
 * {@link printJsonDocument}.
 */
export const printJson = (value: unknown) =>
  isJsonRequested() || isJsonLinesRequested()
    ? printJsonValue(value)
    : Effect.fail(
        new SamvaCliError({
          message: `Internal error: ${commandNameFromArgv(process.argv.slice(2))} printed raw JSON in human mode. Format its human output, or use --json.`,
        }),
      );

/**
 * Print a value as JSON in every output mode. For the commands whose complete result is JSON
 * because it is the input to the next call, such as `templates workspace`.
 */
export const printJsonDocument = printJsonValue;

/** A stable diagnostics schema paired with the versioned result envelope. */
export const printJsonError = (error: unknown, message: string) => {
  const payload = errorEnvelope(error, commandNameFromArgv(process.argv.slice(2)), message);
  return writeOutput(
    process.stderr,
    `${JSON.stringify(payload, null, isJsonLinesRequested() ? undefined : 2)}\n`,
  );
};

/** NDJSON is intentionally unbuffered and versioned, one outer envelope per resource. */
export const printJsonLine = (value: unknown) =>
  writeOutput(
    process.stdout,
    `${JSON.stringify(resultEnvelope(commandNameFromArgv(process.argv.slice(2)), value))}\n`,
  );

/**
 * Drop the dashboard-only `series` from a list row before machine output.
 *
 * The four list endpoints carry a 14-day send series so the dashboard can draw
 * a sparkline in the row. A 100-row `--jsonl` page would carry 1,400 numbers
 * nobody asked for, against `docs/surfaces.md`'s rule that `--json` returns one
 * bounded result. The API and SDK keep the field; the CLI is where it is
 * projected away.
 */
export const withoutSeries = <Row>(row: Row): Omit<Row, "series"> => {
  const { series: _series, ...rest } = row as Row & { series?: unknown };
  return rest as Omit<Row, "series">;
};

export const printResult = (value: unknown, human: string) =>
  isJsonRequested() || isJsonLinesRequested() ? printJson(value) : Console.log(human);

// ── ANSI ────────────────────────────────────────────────────────────────────

/**
 * Whether to emit ANSI styling. `Bun.enableANSIColors` already accounts for a
 * TTY, `NO_COLOR`, and `FORCE_COLOR`, so styling stays off when stdout is piped
 * or the machine path is in use. Read lazily (not at module load) so importing
 * this module stays free of runtime-global side effects — process e2e tests run
 * the CLI under Bun, but unit tests import these helpers under Node/vitest.
 */
const colorsEnabled = (): boolean => Bun.enableANSIColors;

const sgr =
  (open: number, close: number) =>
  (text: string): string =>
    colorsEnabled() ? `\x1b[${open}m${text}\x1b[${close}m` : text;

/** Dim text (gated on {@link colorsEnabled}). */
const dim = sgr(2, 22);

// ── Bounded output ────────────────────────────────────────────────────────────

const MAX_DUMP_LINES = 40;
const MAX_DUMP_CHARS = 4000;

/**
 * Bound a large human-facing text dump (an email body, a template source, a
 * payload preview) so a huge input can't flood the terminal or an agent's
 * context. Appends an explicit truncation tail stating what was dropped. The
 * `--json` path is never truncated — an agent that asked for the payload gets
 * all of it.
 */
export const truncateForDisplay = (
  text: string,
  maxLines = MAX_DUMP_LINES,
  maxChars = MAX_DUMP_CHARS,
): string => {
  let out = text;
  const lines = out.split("\n");
  if (lines.length > maxLines) {
    out = `${lines.slice(0, maxLines).join("\n")}\n${dim(`… ${lines.length - maxLines} more line(s) truncated`)}`;
  }
  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars)}\n${dim(`… truncated at ${maxChars} characters`)}`;
  }
  return out;
};

// ── Fields ────────────────────────────────────────────────────────────────────

/** Print aligned `Label: value` lines, skipping nullish/empty values. */
export const printFields = (fields: ReadonlyArray<readonly [string, unknown]>) => {
  const visible = fields.filter(
    ([, value]) => value !== null && value !== undefined && value !== "",
  );
  // Align on display width so wide glyphs in a label don't skew the column.
  const width = Math.max(0, ...visible.map(([label]) => Bun.stringWidth(label)));
  const lines = visible.map(([label, value]) => {
    const pad = " ".repeat(Math.max(0, width - Bun.stringWidth(label)));
    return `${label}${pad}  ${String(value)}`;
  });
  return Console.log(lines.join("\n"));
};

const sentenceCase = (key: string) => {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const MAX_ROW_DEPTH = 2;

export interface ObjectRowsOptions {
  /**
   * Render `null`, an empty string, `[]`, and `{}` as visible values. A request preview sets it,
   * because a field cleared to nothing is the change being previewed; a result leaves it off, where
   * `printFields` hides an absent optional value on purpose.
   */
  readonly explicit?: boolean;
}

const rowsOf = (
  value: Readonly<Record<string, unknown>>,
  explicit: boolean,
  label: string | undefined,
  depth: number,
): Array<readonly [string, unknown]> =>
  Object.entries(value).flatMap(([key, item]): Array<readonly [string, unknown]> => {
    const name =
      label === undefined ? sentenceCase(key) : `${label} ${sentenceCase(key).toLowerCase()}`;
    if (Array.isArray(item)) {
      if (explicit && item.length === 0) return [[name, "[]"]];
      return [
        [
          name,
          item.every((entry) => !Predicate.isObject(entry))
            ? item.join(", ")
            : JSON.stringify(item),
        ],
      ];
    }
    if (Predicate.isObject(item)) {
      if (explicit && Object.keys(item).length === 0) return [[name, "{}"]];
      return depth < MAX_ROW_DEPTH
        ? rowsOf(item as Record<string, unknown>, explicit, name, depth + 1)
        : [[name, JSON.stringify(item)]];
    }
    if (explicit && item === null) return [[name, "null"]];
    if (explicit && item === "") return [[name, '""']];
    return [[name, item]];
  });

/**
 * Label/value rows for a human view of an API object, so a command with no bespoke layout still
 * carries every fact its JSON does. Keys become sentence-case labels, nested objects extend the
 * label ("Email subject"), scalar arrays join with commas, and anything deeper than
 * {@link MAX_ROW_DEPTH} or an array of objects stays one compact JSON value.
 */
export const objectRows = (
  value: Readonly<Record<string, unknown>>,
  options: ObjectRowsOptions = {},
): Array<readonly [string, unknown]> => rowsOf(value, options.explicit ?? false, undefined, 0);
