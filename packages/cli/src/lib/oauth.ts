import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { CliAuthError, CliTimeoutError, SamvaCliError } from "../errors";
import { createCliAuthClient } from "./auth-client";

/**
 * OAuth device-authorization flow for `samva login`, plus the two other auth
 * calls the product SDK does not cover (sign-out, user-scoped organization
 * list). All of them go through the Better Auth client in `lib/auth-client`.
 */

/** First-party public client id; allow-listed by the AS `validateClient`. */
const SAMVA_CLI_CLIENT_ID = "samva-cli";

const DEVICE_SCOPE = "openid profile email";

export interface DeviceCodeResponse {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete?: string | undefined;
  readonly expires_in: number;
  readonly interval: number;
}

export interface DeviceTokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in: number;
  readonly scope?: string | undefined;
}

/**
 * The client's inferred types describe what the server promises, not what a
 * given deployment answered. The device response drives a browser launch and
 * the poll deadline, so it is validated at the boundary.
 */
const DeviceCodeResponseSchema = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.optional(Schema.String),
  expires_in: Schema.Int,
  interval: Schema.Int,
});

const httpsUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || !URL.canParse(value)) return false;
  return new URL(value).protocol === "https:";
};

const positiveSeconds = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const decodeDeviceCodeResponse = (
  value: unknown,
): Effect.Effect<DeviceCodeResponse, SamvaCliError> =>
  Schema.decodeUnknownEffect(DeviceCodeResponseSchema, {
    onExcessProperty: "ignore",
  })(value).pipe(
    Effect.mapError(() => new SamvaCliError({ message: "Unexpected response from device/code." })),
    Effect.filterOrFail(
      (response) =>
        httpsUrl(response.verification_uri) &&
        (response.verification_uri_complete === undefined ||
          httpsUrl(response.verification_uri_complete)) &&
        positiveSeconds(response.expires_in) &&
        positiveSeconds(response.interval),
      () => new SamvaCliError({ message: "Unexpected response from device/code." }),
    ),
  );

/** Turn a rejected client promise (network, DNS, abort) into the CLI error. */
const requestFailure = (context: string) => (cause: unknown) =>
  new SamvaCliError({ message: `Request to ${context} failed: ${String(cause)}` });

/** RFC 8628 §3.1 — request a device code + user code. */
export const requestDeviceCode = (
  apiUrl: string,
): Effect.Effect<DeviceCodeResponse, SamvaCliError> =>
  Effect.gen(function* () {
    const client = createCliAuthClient(apiUrl);
    const result = yield* Effect.tryPromise({
      try: () => client.device.code({ client_id: SAMVA_CLI_CLIENT_ID, scope: DEVICE_SCOPE }),
      catch: requestFailure("device/code"),
    });
    if (result.error) {
      return yield* new SamvaCliError({
        message: `Could not start login (device/code returned ${result.error.status}). ${
          result.error.error_description ?? result.error.error ?? result.error.statusText
        }`,
      });
    }
    return yield* decodeDeviceCodeResponse(result.data);
  });

/**
 * Internal retry signal for the RFC 8628 poll loop: the grant is not yet
 * decided (`authorization_pending` / `slow_down`). Never escapes
 * `pollForToken` — the retry schedule always recurs on it and only the
 * `expires_in` deadline ends the loop.
 */
class DeviceAuthorizationPending extends Schema.TaggedError<DeviceAuthorizationPending>()(
  "DeviceAuthorizationPending",
  {},
) {}

/**
 * RFC 8628 §3.4 — poll the token endpoint until the user approves, denies, or
 * the code expires. Honors `authorization_pending` / `slow_down` backoff.
 *
 * Clock/Schedule-driven: waits come from a retry schedule whose delay reads a
 * `Ref` holding the current interval (§3.5 `slow_down` grows it by 5s), and
 * the `expires_in` deadline is an `Effect.timeoutOrElse` — all TestClock-
 * advanceable.
 */
export const pollForToken = (
  apiUrl: string,
  deviceCode: string,
  intervalSeconds: number,
  expiresInSeconds: number,
): Effect.Effect<DeviceTokenResponse, CliAuthError | CliTimeoutError | SamvaCliError> =>
  Effect.gen(function* () {
    const client = createCliAuthClient(apiUrl);
    const initialInterval = Duration.seconds(Math.max(intervalSeconds, 1));
    const interval = yield* Ref.make(initialInterval);

    const pollOnce = Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: () =>
          client.device.token({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: deviceCode,
            client_id: SAMVA_CLI_CLIENT_ID,
          }),
        catch: requestFailure("device/token"),
      });

      if (!result.error) return result.data;

      const { error, error_description } = result.error;

      if (error === "authorization_pending") {
        return yield* new DeviceAuthorizationPending();
      }
      if (error === "slow_down") {
        yield* Ref.update(interval, Duration.sum(Duration.seconds(5)));
        return yield* new DeviceAuthorizationPending();
      }
      if (error === "access_denied") {
        return yield* new CliAuthError({
          code: "authorization_denied",
          message: "Login was denied in the browser.",
        });
      }
      if (error === "expired_token") {
        return yield* new CliTimeoutError({
          code: "login_timeout",
          message: "The login request expired before approval. Run `samva login` again.",
        });
      }
      return yield* new SamvaCliError({
        message: `Login failed: ${error_description ?? error ?? result.error.statusText}`,
      });
    });

    const pendingRetry = Schedule.forever.pipe(
      Schedule.setInputType<
        DeviceAuthorizationPending | CliAuthError | CliTimeoutError | SamvaCliError
      >(),
      Schedule.while(({ input }) => input instanceof DeviceAuthorizationPending),
      Schedule.modifyDelay(() => Ref.get(interval)),
    );

    const polling = Effect.gen(function* () {
      // The spec waits the server-provided interval before the first poll too.
      yield* Effect.sleep(initialInterval);
      return yield* pollOnce.pipe(Effect.retry(pendingRetry));
    });

    return yield* polling.pipe(
      // `expires_in` bounds the whole grant: past it the server would answer
      // `expired_token` anyway, so interrupting in-flight work is truthful.
      Effect.timeoutOrElse({
        duration: Duration.seconds(expiresInSeconds),
        orElse: () =>
          Effect.fail(
            new CliTimeoutError({
              code: "login_timeout",
              message: "Login timed out. Run `samva login` again.",
            }),
          ),
      }),
      // Unreachable: `pendingRetry` always recurs on pending signals, so only
      // the deadline ends the loop. Keeps the public error channel clean.
      Effect.catchTag("DeviceAuthorizationPending", () =>
        Effect.fail(
          new CliTimeoutError({
            code: "login_timeout",
            message: "Login timed out. Run `samva login` again.",
          }),
        ),
      ),
    );
  });

export const browserLaunchCommand = (
  url: string,
  platform: NodeJS.Platform,
): readonly [command: string, args: ReadonlyArray<string>] | undefined => {
  if (!httpsUrl(url)) return undefined;
  return platform === "darwin"
    ? (["open", [url]] as const)
    : platform === "win32"
      ? (["rundll32.exe", ["url.dll,FileProtocolHandler", url]] as const)
      : (["xdg-open", [url]] as const);
};

/** Open a URL in the system browser. Best-effort — never fails the flow. */
export const openBrowser = (url: string): Effect.Effect<void> => {
  const launch = browserLaunchCommand(url, process.platform);
  if (launch === undefined) return Effect.void;
  const [command, args] = launch;
  return Effect.tryPromise(async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn(command, [...args], { stdio: "ignore", detached: true });
    // Swallow async spawn errors (e.g. no browser); the caller printed the URL.
    child.on("error", () => undefined);
    child.unref();
  }).pipe(Effect.catchTag("UnknownError", () => Effect.void));
};

/** Best-effort server-side session revoke on logout (Better Auth `/sign-out`). */
export const revokeSession = (
  apiUrl: string,
  accessToken: string,
): Effect.Effect<void, SamvaCliError> =>
  Effect.gen(function* () {
    const client = createCliAuthClient(apiUrl, accessToken);
    yield* Effect.tryPromise({
      try: () => client.signOut(),
      catch: (cause) => new SamvaCliError({ message: `Sign-out request failed: ${String(cause)}` }),
    });
  });

export interface UserOrganization {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

/**
 * List the organizations the signed-in user belongs to (Better Auth org plugin
 * `/organization/list`). User-scoped — unlike the product `organizations.get()`
 * endpoint it needs no `x-org-slug`, so it works immediately after `samva login`.
 */
export const listOrganizations = (
  apiUrl: string,
  accessToken: string,
): Effect.Effect<ReadonlyArray<UserOrganization>, SamvaCliError> =>
  Effect.gen(function* () {
    const client = createCliAuthClient(apiUrl, accessToken);
    const result = yield* Effect.tryPromise({
      try: () => client.organization.list(),
      catch: (cause) =>
        new SamvaCliError({ message: `Could not list organizations: ${String(cause)}` }),
    });
    if (result.error) {
      return yield* new SamvaCliError({
        message: `Could not list organizations (returned ${result.error.status}). ${
          result.error.message ?? result.error.statusText
        }`,
      });
    }
    return result.data;
  });
