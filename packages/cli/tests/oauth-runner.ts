/** Test-only entry point: the released root with a keyring that holds an OAuth session. */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Predicate } from "effect";
import { Command } from "effect/cli";

import { cli } from "../src/cli";
import { Keyring } from "../src/config/credential-store";
import { processErrorCode } from "../src/errors";
import { printJsonError } from "../src/lib/output";
import { outputModeFromArgv, validateProcessArgs } from "../src/lib/runtime";

BunRuntime.runMain(
  validateProcessArgs(process.argv.slice(2)).pipe(
    Effect.andThen(Command.run(cli, { version: "test" })),
    Effect.provide(BunServices.layer),
    Effect.provideService(Keyring.Service, {
      read: () =>
        Effect.succeed(
          JSON.stringify({
            accessToken: "oauth-test-token",
            tokenType: "bearer",
            expiresAt: 4102444800,
          }),
        ),
      write: () => Effect.die("Unscripted keyring write"),
      clear: () => Effect.die("Unscripted keyring clear"),
    }),
    Effect.catch((error) =>
      Effect.gen(function* () {
        process.exitCode = processErrorCode(error);
        // Machine mode mirrors the released boundary's envelope; human mode dumps the typed error.
        if (outputModeFromArgv(process.argv.slice(2)) === "human")
          return yield* Console.error(error);
        yield* printJsonError(
          error,
          Predicate.hasProperty(error, "message") ? String(error.message) : String(error),
        );
      }),
    ),
  ),
  { disableErrorReporting: true },
);
