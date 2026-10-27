import * as Command from "effect/cli/Command";
import * as Effect from "effect/Effect";

import { clearCredentials, readCredentials, resolveApiUrl } from "../config/store";
import { CliConfigError } from "../errors";
import { revokeSession } from "../lib/oauth";
import { printResult } from "../lib/output";

export const logoutCommand = Command.make("logout").pipe(
  Command.withDescription("Sign out and remove stored credentials"),
  Command.withExamples([{ command: "samva logout", description: "Clear stored OAuth tokens" }]),
  Command.withHandler(
    Effect.fnUntraced(function* () {
      const credentials = yield* readCredentials.pipe(
        Effect.catchIf(
          (error): error is CliConfigError =>
            error instanceof CliConfigError && error.code === "invalid_credential_record",
          () => Effect.void,
        ),
      );
      if (credentials) {
        const apiUrl = yield* resolveApiUrl;
        // Best-effort server-side revoke; never block logout on a network error.
        yield* revokeSession(apiUrl, credentials.accessToken).pipe(
          Effect.catchTag("SamvaCliError", () => Effect.void),
        );
      }
      yield* clearCredentials;
      yield* printResult({ action: "logout" }, "Logged out.");
    }),
  ),
);
