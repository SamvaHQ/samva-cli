/** Credential recovery must retain profile identity without depending on the host keyring. */
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import * as Command from "effect/cli/Command";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { profileCommand } from "../src/commands/profile";
import { Keyring } from "../src/config/credential-store";
import {
  decodeStoredCredentials,
  resolveApiUrl,
  resolveExecutionSelection,
  resolveExecutionContext,
  writeCredentials,
  clearCredentials,
  type SamvaConfig,
  isCredentialExpired,
  type SamvaCredentials,
} from "../src/config/store";
import {
  CliAuthError,
  CliConfigError,
  CliTimeoutError,
  processErrorCode,
  processErrorReason,
} from "../src/errors";
import { ApiUrl, Org, Profile, Json, JsonLines, NoInput } from "../src/lib/runtime";

const credentials = (expiresAtSeconds: number): SamvaCredentials => ({
  accessToken: "tok_test",
  tokenType: "bearer",
  expiresAt: expiresAtSeconds,
});

describe("isCredentialExpired", () => {
  it("treats a token as expired once the wall clock reaches its second-resolution expiry", () => {
    // expiresAt is seconds; the clock is milliseconds.
    expect(isCredentialExpired(credentials(1000), 1_000_000)).toBe(true);
    expect(isCredentialExpired(credentials(1000), 1_000_999)).toBe(true);
    expect(isCredentialExpired(credentials(1000), 999_000)).toBe(false);
  });
});

describe("stored credential decoding", () => {
  it.effect("keeps malformed keyring payloads typed and recoverable", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeStoredCredentials("broken", "not-json"));

      expect(error).toBeInstanceOf(CliConfigError);
      expect(error.code).toBe("invalid_credential_record");
    }),
  );

  const setup = (
    identity: "none" | "oauth",
    keyring: Keyring.Interface,
    initialConfig: SamvaConfig = {
      version: 2,
      profiles: { default: { credentialIdentity: identity } },
    },
  ) => {
    let config = initialConfig;
    const provide = <A, E, R>(program: Effect.Effect<A, E, R>) =>
      program.pipe(
        Effect.provideService(Profile, Option.none()),
        // Credential fixtures select their API explicitly so host overrides cannot change the test.
        Effect.provideService(ApiUrl, Option.some("https://api.samva.dev")),
        Effect.provideService(Org, Option.none()),
        Effect.provideService(Keyring.Service, keyring),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            exists: () => Effect.succeed(true),
            readFileString: () => Effect.succeed(JSON.stringify(config)),
            makeDirectory: () => Effect.void,
            writeFileString: (_path, content) =>
              Effect.sync(() => {
                config = JSON.parse(content) as SamvaConfig;
              }),
          }),
        ),
        Effect.provide(Path.layer),
      );
    return { provide, config: () => config };
  };

  const unexpectedKeyring: Keyring.Interface = {
    read: () => Effect.die("Unexpected keyring read"),
    write: () => Effect.die("Unexpected keyring write"),
    clear: () => Effect.die("Unexpected keyring clear"),
  };

  it.effect("does not treat inherited object properties as configured profiles", () =>
    Effect.gen(function* () {
      const fixture = setup("none", unexpectedKeyring, {
        version: 2,
        activeProfile: "toString",
        profiles: {},
      });

      const error = yield* fixture.provide(resolveExecutionSelection).pipe(Effect.flip);

      expect(error).toMatchObject({ code: "unknown_profile" });
    }),
  );

  it.effect("resolves a login URL without reading the OAuth keyring", () =>
    Effect.gen(function* () {
      const fixture = setup("oauth", unexpectedKeyring);
      expect(yield* fixture.provide(resolveApiUrl)).toBe("https://api.samva.dev");
    }),
  );

  it.effect("records OAuth identity before attempting the fallible keyring write", () =>
    Effect.gen(function* () {
      const failure = new CliConfigError({
        code: "credential_store_write_failed",
        message: "Keyring unavailable",
      });
      const fixture = setup("none", {
        ...unexpectedKeyring,
        write: (profile, secret) =>
          Effect.gen(function* () {
            expect(profile).toBe("default");
            expect(JSON.parse(secret)).toEqual(credentials(2000));
            expect(fixture.config().profiles.default?.credentialIdentity).toBe("oauth");
            return yield* failure;
          }),
      });
      expect(yield* fixture.provide(Effect.flip(writeCredentials(credentials(2000))))).toBe(
        failure,
      );
    }),
  );

  it.effect("decodes credentials from the selected profile's keyring entry", () =>
    Effect.gen(function* () {
      const fixture = setup("oauth", {
        ...unexpectedKeyring,
        read: (profile) =>
          Effect.sync(() => {
            expect(profile).toBe("default");
            return JSON.stringify(credentials(2000));
          }),
      });
      const context = yield* fixture.provide(resolveExecutionContext);
      expect(context.credentials).toEqual(credentials(2000));
      expect(context.apiUrl).toBe("https://api.samva.dev");
    }),
  );

  it.effect("keeps keyring read failures visible during credential resolution", () =>
    Effect.gen(function* () {
      const failure = new CliConfigError({
        code: "credential_store_read_failed",
        message: "Keyring locked",
      });
      const fixture = setup("oauth", { ...unexpectedKeyring, read: () => Effect.fail(failure) });
      expect(yield* fixture.provide(Effect.flip(resolveExecutionContext))).toBe(failure);
    }),
  );

  it.effect("deletes an OAuth profile through the injected keyring", () =>
    Effect.gen(function* () {
      const cleared: string[] = [];
      const fixture = setup("oauth", {
        ...unexpectedKeyring,
        clear: (profile) =>
          Effect.sync(() => {
            cleared.push(profile);
          }),
      });
      yield* fixture
        .provide(
          Command.runWith(profileCommand, { version: "test" })(["delete", "default", "--yes"]),
        )
        .pipe(
          Effect.provideService(Json, false),
          Effect.provideService(JsonLines, false),
          Effect.provideService(NoInput, true),
          Effect.provide(BunServices.layer),
        );
      expect(cleared).toEqual(["default"]);
      expect(fixture.config().profiles).toEqual({});
    }),
  );

  it.effect("clears profile identity and reports a failed keyring deletion", () =>
    Effect.gen(function* () {
      const failure = new CliConfigError({
        code: "credential_store_delete_failed",
        message: "Keyring locked",
      });
      const fixture = setup("oauth", {
        ...unexpectedKeyring,
        clear: (profile) =>
          Effect.gen(function* () {
            expect(profile).toBe("default");
            expect(fixture.config().profiles.default?.credentialIdentity).toBe("none");
            return yield* failure;
          }),
      });
      expect(yield* fixture.provide(Effect.flip(clearCredentials))).toBe(failure);
    }),
  );
});

describe("expired credentials map to re-authentication, not a timeout", () => {
  it("routes expired_credentials to CliAuthError exit 4 so agents re-authenticate", () => {
    const error = new CliAuthError({
      code: "expired_credentials",
      message: "Your session has expired. Run `samva login` to sign in again.",
    });
    expect(processErrorCode(error)).toBe(4);
    expect(processErrorReason(error)).toBe("expired_credentials");
  });

  it("keeps genuine device-flow timeouts on exit 124", () => {
    const error = new CliTimeoutError({ code: "login_timeout", message: "Login timed out." });
    expect(processErrorCode(error)).toBe(124);
    expect(processErrorReason(error)).toBe("login_timeout");
  });
});
