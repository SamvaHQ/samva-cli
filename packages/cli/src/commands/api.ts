import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { CliUsageError, SamvaCliError } from "../errors";
import {
  apiRequestPath,
  buildFieldObject,
  fieldQueryPairs,
  type FieldAssignment,
  parseFieldAssignment,
  orderFields,
  parseHeader,
  redactedHeaderValue,
  typedFieldValue,
} from "../lib/api-request";
import { getClientConfig, requestAuthHeaders } from "../lib/client";
import { writeOutput } from "../lib/output";
import { Json, JsonLines, Quiet } from "../lib/runtime";
import { readStdinUtf8 } from "../lib/stdin";

const methodFlag = Flag.String("method").pipe(
  Flag.withAlias("X"),
  Flag.withDescription("HTTP method (default GET, or POST once a field or --input is given)"),
  Flag.optional,
);
const rawFieldFlag = Flag.String("raw-field").pipe(
  Flag.withAlias("f"),
  Flag.withMetavar("key=value"),
  Flag.withDescription("Add a string field (repeatable)"),
  Flag.atLeast(0),
);
const fieldFlag = Flag.String("field").pipe(
  Flag.withAlias("F"),
  Flag.withMetavar("key=value"),
  Flag.withDescription(
    "Add a typed field: true, false, null, and integers become JSON values; @path reads a file, @- reads stdin (repeatable)",
  ),
  Flag.atLeast(0),
);
const headerFlag = Flag.String("header").pipe(
  Flag.withAlias("H"),
  Flag.withMetavar("key:value"),
  Flag.withDescription("Add a request header (repeatable)"),
  Flag.atLeast(0),
);
const inputFlag = Flag.String("input").pipe(
  Flag.withMetavar("file"),
  Flag.withDescription(
    "Send this file as the request body, or - for stdin; fields then go to the query string",
  ),
  Flag.optional,
);
const paginateFlag = Flag.Boolean("paginate").pipe(
  Flag.withDescription("Follow nextCursor and print every page (GET only)"),
  Flag.withDefault(false),
);
const slurpFlag = Flag.Boolean("slurp").pipe(
  Flag.withDescription("With --paginate, print one JSON array of all pages"),
  Flag.withDefault(false),
);
const includeFlag = Flag.Boolean("include").pipe(
  Flag.withAlias("i"),
  Flag.withDescription("Print the response status line and headers before the body"),
  Flag.withDefault(false),
);
const silentFlag = Flag.Boolean("silent").pipe(
  Flag.withDescription("Do not print the response body"),
  Flag.withDefault(false),
);
const verboseFlag = Flag.Boolean("verbose").pipe(
  Flag.withDescription(
    "Write the request and the response status and headers to stderr; credentials are redacted",
  ),
  Flag.withDefault(false),
);

const STDIN_ONCE = new CliUsageError({
  code: "api_stdin_reused",
  message: "Standard input can be read once: use only one of -F key=@-, and --input -.",
});

const decoder = new TextDecoder();
const bodyMethods = new Set(["GET", "HEAD"]);

const isJsonResponse = (response: Response) =>
  /\bjson\b/i.test(response.headers.get("content-type") ?? "");

const withNewline = (text: string) => (text.endsWith("\n") ? text : `${text}\n`);
const parseJson = Option.liftThrowable((text: string): unknown => JSON.parse(text));

/** Pretty-print JSON for a person at a terminal; otherwise the bytes are the server's. */
const renderBody = (bytes: Uint8Array, response: Response): string | Uint8Array => {
  if (!process.stdout.isTTY) return bytes;
  const text = decoder.decode(bytes);
  if (!isJsonResponse(response) || text.length === 0) return withNewline(text);
  return Option.match(parseJson(text), {
    onNone: () => withNewline(text),
    onSome: (value) => `${JSON.stringify(value, null, 2)}\n`,
  });
};

const head = (response: Response) =>
  [
    `HTTP ${response.status}${response.statusText === "" ? "" : ` ${response.statusText}`}`,
    ...[...response.headers].map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ].join("\n");

const traceHead = (prefix: string, line: string, headers: Iterable<readonly [string, string]>) =>
  [
    `${prefix} ${line}`,
    ...[...headers].map(
      ([name, value]) => `${prefix} ${name}: ${redactedHeaderValue(name, value)}`,
    ),
    prefix,
    "",
  ].join("\n");

const send = (
  url: URL,
  init: { method: string; headers: Record<string, string>; body: string | Uint8Array | undefined },
  verbose: boolean,
) =>
  Effect.gen(function* () {
    if (verbose) {
      yield* writeOutput(
        process.stderr,
        traceHead(">", `${init.method} ${url.pathname}${url.search}`, [
          ["host", url.host],
          ...Object.entries(init.headers),
        ]) +
          (init.body === undefined
            ? ""
            : `${typeof init.body === "string" ? init.body : `<${init.body.byteLength} bytes>`}\n`),
      );
    }
    // Redirects are not followed: a followed redirect could carry the API key to another origin.
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(url, {
          method: init.method,
          headers: init.headers,
          body: (init.body as BodyInit | undefined) ?? null,
          redirect: "manual",
          signal,
        }),
      catch: (cause) =>
        new SamvaCliError({ message: `Request to ${url.origin} failed: ${String(cause)}` }),
    });
    const bytes = yield* Effect.tryPromise({
      try: async () => new Uint8Array(await response.arrayBuffer()),
      catch: (cause) =>
        new SamvaCliError({
          message: `Request to ${url.origin} failed: unreadable body: ${String(cause)}`,
        }),
    });
    if (verbose) {
      yield* writeOutput(
        process.stderr,
        traceHead("<", `HTTP ${response.status} ${response.statusText}`.trim(), response.headers),
      );
    }
    return { response, bytes };
  });

const api = Command.make("api", {
  path: Argument.String("path").pipe(
    Argument.withDescription("API path, such as email/domains (the /v1 prefix is optional)"),
  ),
  method: methodFlag,
  rawFields: rawFieldFlag,
  fields: fieldFlag,
  headers: headerFlag,
  input: inputFlag,
  paginate: paginateFlag,
  slurp: slurpFlag,
  include: includeFlag,
  silent: silentFlag,
  verbose: verboseFlag,
}).pipe(
  Command.withDescription(
    [
      "Call any Samva API endpoint with your CLI credentials and print the response body as the API returned it.",
      "Use it when no command covers an operation. `samva api` sends the same credentials as every other command (SAMVA_API_KEY, or the signed-in profile and its organization).",
      "",
      "The path is relative to the API URL: `email/domains`, `/email/domains`, and `/v1/email/domains` are the same request.",
      "The default method is GET, and POST once any field or --input is given; -X overrides it.",
      "-f adds a string field, and -F a typed one (true, false, null, and integers; @path reads a file, @- stdin).",
      "Fields form a JSON body; `a[b]=v` nests and `a[]=v` appends to an array, with `a[]` alone an empty array.",
      "On GET, or with --input, fields go to the query string instead (arrays repeat the key).",
      "",
      "stdout is the response body, byte for byte except that a terminal gets indented JSON; it is not the CLI result envelope, and --json and --jsonl are refused.",
      "A non-2xx response writes its body to stderr and exits 4 for 401 and 403, otherwise 1. Usage errors exit 2.",
      "--paginate follows nextCursor through the cursor query parameter and prints one page per line; add --slurp for one JSON array of pages.",
      "Pipe to jq for filtering. Redirects are not followed.",
    ].join("\n"),
  ),
  Command.withExamples([
    { command: "samva api email/domains", description: "List domains" },
    {
      command: "samva api email/domains --paginate --slurp | jq -r '.[].items[].domain'",
      description: "Every domain across all pages, filtered with jq",
    },
    {
      command: "samva api messages -f limit=5 -X GET",
      description: "Send fields as the query string of a GET",
    },
    {
      command:
        "samva api webhooks -f name=orders -f url=https://example.com/hook -f 'eventTypes[]=message.delivered'",
      description: "Create a resource: fields become a JSON body and the method becomes POST",
    },
    {
      command: "samva api webhooks/wep_abc123 -X DELETE -i",
      description: "Use another method and print the status line and headers",
    },
    {
      command: "cat payload.json | samva api messages --input -",
      description: "Send an exact JSON body from stdin",
    },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* (input) {
      if ((yield* Json) || (yield* JsonLines)) {
        return yield* new CliUsageError({
          code: "api_machine_mode_refused",
          message:
            "samva api prints the API response as returned, not a CLI result envelope. Drop --json/--jsonl and pipe to jq to filter it.",
        });
      }
      if (input.slurp && !input.paginate) {
        return yield* new CliUsageError({
          code: "api_slurp_requires_paginate",
          message: "--slurp requires --paginate.",
        });
      }

      const target = yield* apiRequestPath(input.path);
      const fs = yield* FileSystem.FileSystem;
      let stdinRead = false;
      const readStdin = Effect.suspend((): Effect.Effect<string, SamvaCliError | CliUsageError> => {
        if (stdinRead) return Effect.fail(STDIN_ONCE);
        stdinRead = true;
        return readStdinUtf8;
      });

      const resolveFieldValue = (value: string, field: string) => {
        if (!value.startsWith("@")) return Effect.succeed(value);
        const path = value.slice(1);
        if (path === "-") return readStdin;
        return fs.readFileString(path).pipe(
          Effect.mapError(
            () =>
              new CliUsageError({
                code: "api_field_file_unreadable",
                message: `Could not read ${path} for field ${field}.`,
              }),
          ),
        );
      };

      const assignments: Array<{
        key: string;
        value: string | number | boolean | null | undefined;
      }> = [];
      for (const { flag, typed, raw } of orderFields(
        process.argv.slice(2),
        input.rawFields,
        input.fields,
      )) {
        const assignment: FieldAssignment = yield* parseFieldAssignment(raw, flag);
        if (assignment.value === undefined) {
          assignments.push({ key: assignment.key, value: undefined });
          continue;
        }
        const value = typed
          ? yield* resolveFieldValue(assignment.value, assignment.key)
          : assignment.value;
        assignments.push({
          key: assignment.key,
          value: typed && !assignment.value.startsWith("@") ? typedFieldValue(value) : value,
        });
      }
      const fieldObject = yield* buildFieldObject(assignments);
      const hasFields = assignments.length > 0;

      const inputPath = Option.getOrUndefined(input.input);
      let inputBody: string | Uint8Array | undefined;
      if (inputPath !== undefined) {
        inputBody =
          inputPath === "-"
            ? yield* readStdin
            : yield* fs.readFile(inputPath).pipe(
                Effect.mapError(
                  () =>
                    new CliUsageError({
                      code: "api_input_unreadable",
                      message: `Could not read ${inputPath} for --input.`,
                    }),
                ),
              );
      }

      const method = (
        Option.getOrUndefined(input.method) ??
        (hasFields || inputBody !== undefined ? "POST" : "GET")
      ).toUpperCase();
      if (!/^[A-Z]+$/.test(method)) {
        return yield* new CliUsageError({
          code: "api_method_invalid",
          message: `${method} is not an HTTP method.`,
        });
      }
      if (input.paginate && method !== "GET") {
        return yield* new CliUsageError({
          code: "api_paginate_requires_get",
          message: "--paginate follows list responses and requires GET.",
        });
      }

      // Fields are the body unless the method cannot carry one or --input already is the body.
      const fieldsInQuery = hasFields && (bodyMethods.has(method) || inputBody !== undefined);
      if (inputBody !== undefined && bodyMethods.has(method)) {
        return yield* new CliUsageError({
          code: "api_body_method_invalid",
          message: `${method} cannot carry a body. Use -X POST, -X PUT, or -X PATCH with --input.`,
        });
      }
      const body: string | Uint8Array | undefined =
        inputBody ?? (hasFields && !fieldsInQuery ? JSON.stringify(fieldObject) : undefined);

      const config = yield* getClientConfig;
      const headers: Record<string, string> = {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      };
      const lowerNames = new Map<string, string>(Object.keys(headers).map((k) => [k, k]));
      const setHeader = (name: string, value: string) => {
        const existing = lowerNames.get(name.toLowerCase());
        if (existing !== undefined) delete headers[existing];
        lowerNames.set(name.toLowerCase(), name);
        headers[name] = value;
      };
      for (const [name, value] of Object.entries(requestAuthHeaders(config)))
        setHeader(name, value);
      for (const raw of input.headers) {
        const [name, value] = yield* parseHeader(raw);
        setHeader(name, value);
      }

      const url = new URL(`${config.baseUrl?.replace(/\/+$/, "") ?? ""}${target}`);
      if (fieldsInQuery) {
        for (const [key, value] of fieldQueryPairs(fieldObject))
          url.searchParams.append(key, value);
      }

      const quiet = input.silent || (yield* Quiet);
      const pages: Array<unknown> = [];
      let cursor: string | undefined;
      let failed = false;
      while (true) {
        if (cursor !== undefined) url.searchParams.set("cursor", cursor);
        const { response, bytes } = yield* send(url, { method, headers, body }, input.verbose);

        if (!response.ok) {
          // The raw response is the output of this command, so the failure is not rendered as a CLI
          // diagnostic: the body goes to stderr and only the exit code is the CLI's.
          if (input.include) yield* writeOutput(process.stdout, head(response));
          const text = decoder.decode(bytes);
          yield* writeOutput(
            process.stderr,
            text.length === 0
              ? `HTTP ${response.status}${response.statusText === "" ? "" : ` ${response.statusText}`}\n`
              : text.endsWith("\n")
                ? text
                : `${text}\n`,
          );
          process.exitCode = [401, 403].includes(response.status) ? 4 : 1;
          failed = true;
          break;
        }

        if (input.include && !quiet) yield* writeOutput(process.stdout, head(response));

        if (!input.paginate) {
          if (!quiet) yield* writeOutput(process.stdout, renderBody(bytes, response));
          break;
        }

        const parsed: unknown = yield* Effect.try({
          try: () => JSON.parse(decoder.decode(bytes)) as unknown,
          catch: () =>
            new SamvaCliError({
              message: `--paginate needs a JSON response from ${url.pathname}; the page was not JSON.`,
            }),
        });
        if (input.slurp) pages.push(parsed);
        else if (!quiet) {
          yield* writeOutput(process.stdout, renderBody(bytes, response));
          // A page is one line, so a body without a trailing newline cannot run into the next page.
          if (!process.stdout.isTTY && bytes.at(-1) !== 10)
            yield* writeOutput(process.stdout, "\n");
        }

        const next =
          Predicate.isObject(parsed) && !Array.isArray(parsed) ? parsed["nextCursor"] : undefined;
        if (typeof next !== "string" || next.length === 0) break;
        if (next === cursor) {
          return yield* new SamvaCliError({
            message: `The API returned the same nextCursor twice (${next}); stopped paging.`,
          });
        }
        cursor = next;
      }

      if (input.slurp && !failed && !quiet) {
        yield* writeOutput(
          process.stdout,
          `${JSON.stringify(pages, null, process.stdout.isTTY ? 2 : undefined)}\n`,
        );
      }
    }),
  ),
);

export const apiCommand = api;
