import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { resolveApiUrl, writeCredentials } from "../config/store";
import { CliUsageError } from "../errors";
import { AGENT_AUTH_HINT } from "../lib/examples";
import { openBrowser, pollForToken, requestDeviceCode } from "../lib/oauth";
import { printResult } from "../lib/output";
import { Json, JsonLines, NoInput } from "../lib/runtime";

const noBrowserFlag = Flag.Boolean("no-browser").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print the verification URL instead of opening a browser"),
);

export const loginCommand = Command.make("login", { noBrowser: noBrowserFlag }).pipe(
  Command.withDescription(
    `Sign in to Samva in your browser (OAuth device flow). ${AGENT_AUTH_HINT}`,
  ),
  Command.withExamples([
    {
      command: "samva login",
      description: "Interactive OAuth (opens browser)",
    },
    {
      command: "samva login --no-browser",
      description: "Print verification URL instead of opening a browser",
    },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ noBrowser }) {
      const machine = (yield* Json) || (yield* JsonLines);
      if (machine || (yield* NoInput)) {
        return yield* new CliUsageError({
          code: "interactive_login_disabled",
          message:
            "Login is interactive and unavailable with --json, --jsonl, or --no-input. Use human mode, or set SAMVA_API_KEY for automation.",
        });
      }
      if (!process.stdin.isTTY && !noBrowser) {
        return yield* new CliUsageError({
          code: "non_interactive_login_requires_device_flow",
          message:
            "Login without a terminal requires SAMVA_API_KEY for automation. To use OAuth device flow explicitly, run `samva login --no-browser`.",
        });
      }
      const apiUrl = yield* resolveApiUrl;
      const device = yield* requestDeviceCode(apiUrl);

      const verifyUrl = device.verification_uri_complete ?? device.verification_uri;
      yield* Console.error(
        `\nTo authorize the Samva CLI, visit:\n\n  ${device.verification_uri}\n`,
      );
      yield* Console.error(`and enter the code:\n\n  ${device.user_code}\n`);

      if (noBrowser) {
        yield* Console.error(`Or open this URL directly:\n\n  ${verifyUrl}\n`);
      } else {
        yield* openBrowser(verifyUrl);
        yield* Effect.logInfo("Opened your browser to finish login. Waiting for approval…");
      }

      const token = yield* pollForToken(
        apiUrl,
        device.device_code,
        device.interval,
        device.expires_in,
      );

      const nowMs = yield* Clock.currentTimeMillis;
      yield* writeCredentials({
        accessToken: token.access_token,
        tokenType: token.token_type,
        expiresAt: Math.floor(nowMs / 1000) + token.expires_in,
        scope: token.scope,
      });
      yield* printResult({ action: "login" }, "Logged in.");
    }),
  ),
);
