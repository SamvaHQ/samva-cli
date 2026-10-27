/**
 * The keyring speaks two different command grammars, and the wrong one silently
 * looks up nothing on the other platform. These pin the argv the CLI hands the
 * operating-system credential store, and that a credential never rides in argv.
 */
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  isMissingSecretResult,
  Keyring,
  writeCredentialCommand,
} from "../src/config/credential-store";

const nativePlatform = Object.getOwnPropertyDescriptor(process, "platform");

/** The keyring reads `process.platform`; the host running the suite must not decide the grammar. */
const runningOn = (platform: NodeJS.Platform): void => {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
    enumerable: true,
    writable: false,
  });
};

interface SpawnRequest {
  readonly cmd: ReadonlyArray<string>;
}

/**
 * Bun's process spawner is the outermost boundary Samva does not own. The fake
 * answers like a credential tool that found the item, so the argv the keyring
 * built is the only thing under test.
 */
const recordSpawns = (stdout: string): ReadonlyArray<SpawnRequest> => {
  const requests: Array<SpawnRequest> = [];
  vi.stubGlobal("Bun", {
    spawn: (options: { readonly cmd: ReadonlyArray<string> }) => {
      requests.push({ cmd: [...options.cmd] });
      return { stdout, stderr: "", exited: Promise.resolve(0) };
    },
  });
  return requests;
};

const readProfile = (profile: string) =>
  Effect.gen(function* () {
    const keyring = yield* Keyring.Service;
    return yield* keyring.read(profile);
  }).pipe(Effect.provide(Keyring.layer));

afterEach(() => {
  if (nativePlatform !== undefined) Object.defineProperty(process, "platform", nativePlatform);
  vi.unstubAllGlobals();
});

describe("credential-store command boundary", () => {
  it("keeps a credential out of every argv position", () => {
    const secret = "samva_sk_never_in_argv";
    const command = writeCredentialCommand("darwin", "security", "profile-a", secret);
    expect(command.args).not.toContain(secret);
    expect(command.args).toEqual(["security", "-i"]);
    expect(command.input).not.toContain(secret);
    expect(command.input).toContain("-s dev.samva.cli");
    expect(command.input).toContain(Buffer.from(secret, "utf8").toString("hex"));
  });

  it("only treats the platform's precise missing-secret result as absent", () => {
    expect(
      isMissingSecretResult("darwin", {
        exitCode: 44,
        stdout: "",
        stderr: "The specified item could not be found in the keychain.",
      }),
    ).toBe(true);
    expect(
      isMissingSecretResult("darwin", {
        exitCode: 44,
        stdout: "",
        stderr: "Das angegebene Objekt wurde im Schlüsselbund nicht gefunden.",
      }),
    ).toBe(true);
    expect(
      isMissingSecretResult("darwin", {
        exitCode: 36,
        stdout: "",
        stderr: "User interaction is not allowed.",
      }),
    ).toBe(false);
    expect(isMissingSecretResult("linux", { exitCode: 1, stdout: "", stderr: "" })).toBe(true);
    expect(
      isMissingSecretResult("linux", {
        exitCode: 1,
        stdout: "",
        stderr: "backend unavailable",
      }),
    ).toBe(false);
  });

  it.effect("reads a macOS profile as a Keychain generic password", () =>
    Effect.gen(function* () {
      runningOn("darwin");
      const requests = recordSpawns("samva_sk_from_the_keychain");

      yield* readProfile("release");

      expect(requests.map((request) => request.cmd)).toEqual([
        [
          "/usr/bin/security",
          "find-generic-password",
          "-s",
          "dev.samva.cli",
          "-a",
          "release",
          "-w",
        ],
      ]);
    }),
  );

  it.effect("reads a Linux profile by secret-tool's service and profile attributes", () =>
    Effect.gen(function* () {
      runningOn("linux");
      const requests = recordSpawns("samva_sk_from_secret_tool");

      yield* readProfile("release");

      expect(requests.map((request) => request.cmd)).toEqual([
        ["secret-tool", "lookup", "service", "dev.samva.cli", "profile", "release"],
      ]);
    }),
  );
});
