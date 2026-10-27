import { BunRuntime, BunServices } from "@effect/platform-bun";
import PackageJson from "@samva/cli/package.json" with { type: "json" };
import * as CliError from "effect/cli/CliError";
import * as CliOutput from "effect/cli/CliOutput";
import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as LogLevel from "effect/LogLevel";
import * as Predicate from "effect/Predicate";

import { Keyring } from "./config/credential-store";
import {
  CliMessageLifecycleError,
  CliResultError,
  CliUsageError,
  processErrorCode,
  processErrorNext,
  formatErrorDetails,
} from "./errors";
import { helpDocJson } from "./lib/help-json";
import { printJsonError, resultEnvelope, writeOutput } from "./lib/output";
import {
  commandNameFromArgv,
  isKnownRootCommand,
  outputModeFromArgv,
  validateProcessArgs,
} from "./lib/runtime";

export const runCli = <Name extends string, Input, ContextInput, CommandError>(
  cli: Command.Command<
    Name,
    Input,
    ContextInput,
    CommandError,
    BunServices.BunServices | Keyring.Service
  >,
) => {
  const argv = process.argv.slice(2);
  const outputMode = outputModeFromArgv(argv);
  const machineMode = outputMode === "json" || outputMode === "jsonl";
  const optionTerminator = argv.indexOf("--");
  const processArgs = optionTerminator === -1 ? argv : argv.slice(0, optionTerminator);
  const rootOptionsWithValue = new Set(["--profile", "--api-url", "--org", "--log-level"]);
  const rootMachineHelp = (() => {
    let requested = false;
    const tokens = processArgs.values();
    for (const token of tokens) {
      if (token === "--help" || token === "-h") {
        requested = true;
        continue;
      }
      if (rootOptionsWithValue.has(token)) {
        tokens.next();
        continue;
      }
      if (token.startsWith("-")) continue;
      return { requested, command: token };
    }
    return { requested, command: undefined };
  })();
  /** Any `--help`/`-h` before `--` asks for the command's help document. */
  const helpRequested = processArgs.some((token) => token === "--help" || token === "-h");
  const isUnknownRootMachineHelp =
    machineMode &&
    rootMachineHelp.requested &&
    rootMachineHelp.command !== undefined &&
    !isKnownRootCommand(rootMachineHelp.command);

  /** Status belongs on a TTY stderr; stdout is result data only. */
  const cliLogger = Logger.make(({ logLevel, message }) => {
    const text = (Array.isArray(message) ? message : [message]).map(String).join(" ");
    if (LogLevel.isGreaterThanOrEqualTo(logLevel, "Warn")) {
      process.stderr.write(`${text}\n`);
    } else if (outputMode === "human" && process.stderr.isTTY) {
      process.stderr.write(`${text}\n`);
    }
  });

  const messageFor = (error: unknown): string => {
    if (error instanceof Error) return error.message;
    if (Predicate.isObject(error) && Predicate.hasProperty(error, "message")) {
      const message = error.message;
      if (typeof message === "string") return message;
    }
    return "Samva CLI failed unexpectedly.";
  };

  /**
   * A bare root or parent command (no subcommand) fails as `ShowHelp` with no
   * parse errors. The framework already rendered its help into the stdout buffer,
   * so this failure is really a help request — not a diagnostic.
   */
  const isBareHelp = (error: unknown): error is CliError.ShowHelp =>
    error instanceof CliError.ShowHelp && error.errors.length === 0;

  /**
   * On a parse failure the framework renders a full-width `ERROR` block to stderr
   * via `Console.error`. We render our own single diagnostic (a `✗` line or the
   * JSON envelope), so blank the framework's error rendering here and drop the
   * resulting empty write inside the buffer. Help-doc rendering is untouched, so
   * `--help` and bare-command help are unaffected.
   */
  const formatter: CliOutput.Formatter = {
    ...CliOutput.defaultFormatter(),
    formatError: () => "",
    formatErrors: () => "",
    // Machine callers asking for help get the command's structured help as the
    // one result line the buffer expects, never the framework's multi-line text.
    ...(machineMode && helpRequested
      ? {
          formatHelpDoc: (doc: Parameters<CliOutput.Formatter["formatHelpDoc"]>[0]) =>
            JSON.stringify(helpDocJson(doc)),
        }
      : {}),
  };

  type StdoutBuffer = {
    readonly originalLog: typeof console.log;
    readonly originalError: typeof console.error;
    readonly lines: Array<string>;
  };

  const flushSuccessfulResults = (state: StdoutBuffer, partial = false) =>
    Effect.gen(function* () {
      if (outputMode === "quiet") return;
      if (outputMode === "jsonl") {
        // Streaming commands write their own lines; only a help request is
        // buffered, and it is one envelope.
        if (helpRequested && state.lines.length === 1) {
          yield* writeOutput(
            process.stdout,
            `${JSON.stringify(resultEnvelope(commandNameFromArgv(argv), JSON.parse(state.lines[0]!)))}\n`,
          );
        }
        return;
      }
      if (outputMode === "human") {
        if (state.lines.length > 0) {
          yield* writeOutput(process.stdout, `${state.lines.join("\n")}\n`);
        }
        return;
      }
      const data = yield* Effect.try({
        try: () => {
          if (state.lines.length !== 1) {
            return { invalid: true as const, count: state.lines.length };
          }
          return { invalid: false as const, data: JSON.parse(state.lines[0]!) as unknown };
        },
        catch: () => ({ invalid: true as const, count: state.lines.length }),
      });
      if (data.invalid) {
        // This is an implementation defect, never a raw mixed stream. The
        // process boundary refuses to publish an ambiguous JSON response.
        process.exitCode = 1;
        yield* printJsonError(
          undefined,
          "The command did not produce exactly one machine-readable result.",
        );
        return;
      }
      yield* writeOutput(
        process.stdout,
        `${JSON.stringify(
          resultEnvelope(commandNameFromArgv(argv), data.data, partial ? true : undefined),
          null,
          2,
        )}\n`,
      );
    });

  const flushLifecycleResult = (state: StdoutBuffer, error: CliMessageLifecycleError) =>
    Effect.gen(function* () {
      state.lines.length = 0;
      if (outputMode === "quiet") return;
      if (outputMode === "human") {
        yield* writeOutput(process.stdout, `${error.human}\n`);
        return;
      }
      const result = resultEnvelope(commandNameFromArgv(argv), error.partialMessage, true);
      yield* writeOutput(
        process.stdout,
        `${JSON.stringify(result, null, outputMode === "jsonl" ? undefined : 2)}\n`,
      );
    });

  const flushFailedResult = (state: StdoutBuffer, error: CliResultError) =>
    Effect.gen(function* () {
      state.lines.length = 0;
      if (outputMode === "quiet") return;
      if (outputMode === "human") {
        yield* writeOutput(process.stdout, `${error.human}\n`);
        return;
      }
      const result = resultEnvelope(commandNameFromArgv(argv), error.result);
      yield* writeOutput(
        process.stdout,
        `${JSON.stringify(result, null, outputMode === "jsonl" ? undefined : 2)}\n`,
      );
    });

  const withStdoutBuffer = <E, R>(program: Effect.Effect<void, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync((): StdoutBuffer => {
        const originalLog = console.log;
        const originalError = console.error;
        const lines: Array<string> = [];
        console.log = ((...values: Array<unknown>) => {
          lines.push(values.map(String).join(" "));
        }) as typeof console.log;
        // Drop the framework's now-blank parse-error write so machine stderr
        // carries only our JSON diagnostic and human stderr only one line.
        console.error = ((...values: Array<unknown>) => {
          if (values.map(String).join(" ").length === 0) return;
          originalError(...(values as Array<never>));
        }) as typeof console.error;
        return { originalLog, originalError, lines };
      }),
      (state) =>
        program.pipe(
          Effect.tap(() => flushSuccessfulResults(state)),
          Effect.tapError((error) => {
            // A bare/parent command's help IS its output — flush it in human
            // mode. Lifecycle polling is the other exception: its last
            // authoritative Message is useful even when the terminal result is
            // a timeout or a delivery failure. Every other failure discards
            // tentative result data.
            if (isBareHelp(error) && outputMode === "human") {
              return writeOutput(process.stdout, `${state.lines.join("\n")}\n`);
            }
            if (error instanceof CliMessageLifecycleError) {
              return flushLifecycleResult(state, error);
            }
            if (error instanceof CliResultError) {
              return flushFailedResult(state, error);
            }
            return Effect.sync(() => {
              state.lines.length = 0;
            });
          }),
        ),
      (state) =>
        Effect.sync(() => {
          console.log = state.originalLog;
          console.error = state.originalError;
          state.lines.length = 0;
        }),
    );

  const renderFailure = (error: unknown) =>
    Effect.gen(function* () {
      process.exitCode = processErrorCode(error);
      // Bare/parent command with no subcommand: the help already went to stdout in
      // human mode, so add no diagnostic there; machine callers get one line.
      if (isBareHelp(error)) {
        if (machineMode) yield* printJsonError(error, messageFor(error));
        return;
      }
      const message =
        error instanceof CliError.ShowHelp && error.errors.length > 0
          ? `${error.errors[0]?.message ?? "Invalid command input."}\nTry: ${error.commandPath.join(" ")} --help`
          : messageFor(error);
      if (!machineMode) {
        const next = processErrorNext(error);
        yield* Console.error(
          `✗ ${message}${formatErrorDetails(error)}${next === undefined ? "" : `\nTry: ${next}`}`,
        );
        return;
      }
      yield* printJsonError(error, message);
    });

  // Error reporting is deliberately owned here. Command handlers preserve typed
  // errors; the process boundary maps them once to stderr and an honest exit code.
  const program = (
    isUnknownRootMachineHelp
      ? validateProcessArgs(argv).pipe(
          Effect.flatMap(
            () =>
              new CliUsageError({
                code: "unknown_subcommand",
                message: `Unknown subcommand ${JSON.stringify(rootMachineHelp.command)} for samva.`,
              }),
          ),
        )
      : withStdoutBuffer(
          validateProcessArgs(argv).pipe(
            Effect.flatMap(() => Command.run(cli, { version: PackageJson.version })),
          ),
        )
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        Logger.layer([cliLogger]),
        BunServices.layer,
        CliOutput.layer(formatter),
        Keyring.layer,
      ),
    ),
    Effect.matchEffect({
      onFailure: renderFailure,
      onSuccess: () => Effect.void,
    }),
  );

  BunRuntime.runMain(program, { disableErrorReporting: true });
};
