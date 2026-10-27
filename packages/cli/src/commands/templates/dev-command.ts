import { resolve } from "node:path";

import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { SamvaCliError } from "../../errors";
import { dirFlag } from "./flags";
import {
  brandResolverPrelude,
  OPTIONS_PRELUDE,
  requireCompatibleToolchain,
  toolchainFailure,
} from "./toolchain";

const devScript = () => `import { startDevServer } from "@samva/vite/dev";
${OPTIONS_PRELUDE}
${brandResolverPrelude()}
const server = await startDevServer(options);
process.stdout.write("Samva template editor: " + server.url + "\\nPress Ctrl+C to stop.\\n");
const stop = () => { server.close().finally(() => process.exit(0)); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);`;

/**
 * Starts the editor under Node.js from the project's own `@samva/vite/dev`, so the compiler and
 * editor versions are the ones its lockfile pins. Resolves once the server has closed.
 */
const runDevServer = (input: {
  readonly dir: string | undefined;
  readonly port: number | undefined;
  readonly host: string | undefined;
  readonly open: boolean;
}): Effect.Effect<void, SamvaCliError> =>
  Effect.andThen(
    requireCompatibleToolchain("Could not start the template editor"),
    Effect.tryPromise({
      try: async (interrupted) => {
        const child = Bun.spawn(["node", "--input-type=module", "--eval", devScript()], {
          cwd: process.cwd(),
          env: {
            ...Bun.env,
            SAMVA_TOOLCHAIN_INPUT: JSON.stringify({
              root: process.cwd(),
              ...(input.dir === undefined ? {} : { dir: input.dir }),
              ...(input.port === undefined ? {} : { port: input.port }),
              ...(input.host === undefined ? {} : { host: input.host }),
              open: input.open,
            }),
          },
          stdout: "inherit",
          stderr: "pipe",
        });
        // The runtime turns a signal into an interruption and may exit before a listener below
        // runs, so the interruption stops the editor too.
        interrupted.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
        const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
        const onInterrupt = forward("SIGINT");
        const onTerminate = forward("SIGTERM");
        process.on("SIGINT", onInterrupt);
        process.on("SIGTERM", onTerminate);
        let stderr = "";
        const drain = (async () => {
          for await (const chunk of child.stderr) {
            stderr += Buffer.from(chunk).toString();
            process.stderr.write(chunk);
          }
        })();
        const exitCode = await child.exited;
        await drain;
        process.off("SIGINT", onInterrupt);
        process.off("SIGTERM", onTerminate);
        if (exitCode !== 0 && child.signalCode === null) {
          return Promise.reject(
            new SamvaCliError({
              message: toolchainFailure(stderr, "Could not start the template editor"),
            }),
          );
        }
      },
      catch: (cause) =>
        cause instanceof SamvaCliError
          ? cause
          : new SamvaCliError({
              message: `Could not start the template editor. Install Node.js 22+: ${String(cause)}`,
            }),
    }),
  );

export const devCommand = Command.make("dev", {
  dir: dirFlag,
  port: Flag.Int("port").pipe(
    Flag.withDescription("Port to listen on (default: Vite's, 5173, or the next free one)"),
    Flag.optional,
  ),
  host: Flag.String("host").pipe(
    Flag.withDescription("Interface to listen on (default: loopback only)"),
    Flag.optional,
  ),
  open: Flag.Boolean("open").pipe(
    Flag.withDescription("Open the editor in a browser once it is listening"),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Start the local visual editor for the templates in this project; no vite.config.ts needed",
  ),
  Command.withExamples([
    { command: "samva templates dev", description: "Serve templates/ and emails/" },
    {
      command: "samva templates dev --dir templates --port 4000 --open",
      description: "Serve one directory on a fixed port and open the browser",
    },
  ]),
  Command.withHandler(({ dir, port, host, open }) =>
    runDevServer({
      dir: Option.map(dir, (value) => resolve(value)).pipe(Option.getOrUndefined),
      port: Option.getOrUndefined(port),
      host: Option.getOrUndefined(host),
      open,
    }),
  ),
);
