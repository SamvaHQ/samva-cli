import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CliConfigError } from "../errors";

const SERVICE = "dev.samva.cli";

export interface SecretCommand {
  readonly args: ReadonlyArray<string>;
  readonly input?: string | undefined;
}

const readCredentialCommand = (
  platform: NodeJS.Platform,
  command: string,
  profile: string,
): SecretCommand =>
  platform === "darwin"
    ? { args: [command, "find-generic-password", "-s", SERVICE, "-a", profile, "-w"] }
    : { args: [command, "lookup", "service", SERVICE, "profile", profile] };

export const writeCredentialCommand = (
  platform: NodeJS.Platform,
  command: string,
  profile: string,
  secret: string,
): SecretCommand =>
  platform === "darwin"
    ? {
        // Interactive mode reads the entire command from stdin. Hex password
        // data avoids both argv exposure and prompt ambiguity around `-w`.
        args: [command, "-i"],
        input: `add-generic-password -U -s ${SERVICE} -a ${profile} -X ${Buffer.from(secret, "utf8").toString("hex")}\n`,
      }
    : {
        args: [
          command,
          "store",
          "--label",
          `Samva CLI profile ${profile}`,
          "service",
          SERVICE,
          "profile",
          profile,
        ],
        input: secret,
      };

const commandForPlatform = () => {
  if (process.platform === "darwin") return "/usr/bin/security";
  if (process.platform === "linux") return "secret-tool";
  return undefined;
};

const runSecretCommand = (args: ReadonlyArray<string>, input?: string) =>
  Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn({
        cmd: [...args],
        stdin: input === undefined ? "ignore" : new Blob([input]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
    },
    catch: () =>
      new CliConfigError({
        code: "credential_store_unavailable",
        message: "Could not run the operating-system credential store.",
      }),
  });

const keyring = () => {
  const command = commandForPlatform();
  return command === undefined
    ? Effect.fail(
        new CliConfigError({
          code: "credential_store_unsupported",
          message: "Samva CLI credentials require macOS Keychain or Linux secret-tool.",
        }),
      )
    : Effect.succeed(command);
};

export const isMissingSecretResult = (
  platform: NodeJS.Platform,
  result: { readonly stdout: string; readonly stderr: string; readonly exitCode: number },
): boolean =>
  platform === "darwin"
    ? // errSecItemNotFound — the exit code is locale-independent; Security.framework
      // stderr text is localized, so it must not participate in the check.
      result.exitCode === 44
    : platform === "linux"
      ? result.exitCode === 1 && result.stdout.length === 0 && result.stderr.length === 0
      : false;

/** Read one profile secret. A missing item is normal; no plaintext fallback exists. */
const readCredentialSecret = Effect.fn("Keyring.read")(function* (profile: string) {
  const command = yield* keyring();
  const spec = readCredentialCommand(process.platform, command, profile);
  const result = yield* runSecretCommand(spec.args, spec.input);
  if (result.exitCode !== 0) {
    if (isMissingSecretResult(process.platform, result)) return undefined;
    return yield* new CliConfigError({
      code: "credential_store_read_failed",
      message: "Could not read credentials from the operating-system credential store.",
    });
  }
  return result.stdout;
});

/** Store a secret in the OS keyring. Failure is explicit and never falls back to a file. */
const writeCredentialSecret = Effect.fn("Keyring.write")(function* (
  profile: string,
  secret: string,
) {
  const command = yield* keyring();
  const spec = writeCredentialCommand(process.platform, command, profile, secret);
  const result = yield* runSecretCommand(spec.args, spec.input);
  if (result.exitCode !== 0) {
    return yield* new CliConfigError({
      code: "credential_store_write_failed",
      message: "Could not save credentials in the operating-system credential store.",
    });
  }
});

const clearCredentialSecret = Effect.fn("Keyring.clear")(function* (profile: string) {
  const command = yield* keyring();
  const result =
    process.platform === "darwin"
      ? yield* runSecretCommand([command, "delete-generic-password", "-s", SERVICE, "-a", profile])
      : yield* runSecretCommand([command, "clear", "service", SERVICE, "profile", profile]);
  // Deleting a missing credential is intentionally idempotent; every other
  // keyring failure remains visible rather than pretending logout succeeded.
  if (result.exitCode !== 0 && !isMissingSecretResult(process.platform, result)) {
    return yield* new CliConfigError({
      code: "credential_store_delete_failed",
      message: "Could not remove credentials from the operating-system credential store.",
    });
  }
});

export interface Interface {
  readonly read: (profile: string) => Effect.Effect<string | undefined, CliConfigError>;
  readonly write: (profile: string, secret: string) => Effect.Effect<void, CliConfigError>;
  readonly clear: (profile: string) => Effect.Effect<void, CliConfigError>;
}

/** Operating-system secret storage; production never falls back to plaintext. */
export class Service extends Context.Service<Service, Interface>()("@samva/cli/Keyring") {}

export const layer = Layer.succeed(
  Service,
  Service.of({
    read: readCredentialSecret,
    write: writeCredentialSecret,
    clear: clearCredentialSecret,
  }),
);

// oxlint-disable-next-line import/no-self-import -- Samva projected modules expose their namespace from the owning file.
export * as Keyring from "./credential-store";
