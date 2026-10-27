import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { SAMVA_API_KEY, SAMVA_API_URL, SAMVA_ORG, SAMVA_PROFILE } from "../env";
import { CliAuthError, CliConfigError, CliUsageError } from "../errors";
import { ApiUrl, Org, Profile } from "../lib/runtime";
import { Keyring } from "./credential-store";
import { configDir, configFilePath } from "./paths";

const DEFAULT_API_URL = "https://api.samva.dev";
const ProfileNameSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
);

interface SamvaProfile {
  readonly orgSlug?: string | undefined;
  readonly credentialIdentity: "none" | "oauth";
}

const ProfileSchema = Schema.Struct({
  orgSlug: Schema.optional(Schema.String),
  credentialIdentity: Schema.Literals(["none", "oauth"]),
});

const ConfigSchema = Schema.Struct({
  version: Schema.Literal(2),
  activeProfile: Schema.optional(Schema.String),
  profiles: Schema.Record(ProfileNameSchema, ProfileSchema),
});

const CredentialsSchema = Schema.Struct({
  accessToken: Schema.String,
  tokenType: Schema.String,
  expiresAt: Schema.Finite,
  scope: Schema.optional(Schema.String),
});

/** Non-secret user-level execution contexts. Credentials stay in the OS keyring. */
export interface SamvaConfig {
  readonly version: 2;
  readonly activeProfile?: string | undefined;
  readonly profiles: Readonly<Record<string, SamvaProfile>>;
}

export interface SamvaCredentials {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly expiresAt: number;
  readonly scope?: string | undefined;
}

export interface ExecutionContext {
  readonly profile: string;
  readonly apiUrl: string;
  /** Org for this invocation: `--org` > `SAMVA_ORG` > the profile's stored org. */
  readonly orgSlug?: string | undefined;
  /** The profile's stored org, ignoring one-shot overrides. */
  readonly profileOrgSlug?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly credentials?: SamvaCredentials | undefined;
}

type ExecutionSelection = Omit<ExecutionContext, "credentials">;

const emptyConfig: SamvaConfig = { version: 2, profiles: {} };

export const validateProfileName = (name: string) =>
  Schema.decodeEffect(ProfileNameSchema)(name).pipe(
    Effect.mapError(
      () =>
        new CliUsageError({
          code: "invalid_profile_name",
          message:
            "Profile names must be 1-64 characters and contain only letters, numbers, dots, underscores, or hyphens.",
        }),
    ),
  );

const parseConfig = (raw: string, file: string) =>
  Effect.gen(function* () {
    const rawValue = yield* Effect.try({
      try: () => JSON.parse(raw) as Partial<SamvaConfig>,
      catch: () =>
        new CliConfigError({
          code: "invalid_config",
          message: `Could not parse CLI config at ${file}. Fix or delete it.`,
        }),
    });
    // Struct decoding drops unknown keys, so a stored `target` would otherwise
    // be ignored silently and the profile would reach a different API.
    const targetProfile = profileWithTarget(rawValue);
    if (targetProfile !== undefined) {
      return yield* new CliConfigError({
        code: "unsupported_profile_target",
        message: `Profile ${targetProfile} in ${file} sets "target", which profiles do not carry. Remove that key from the file and select the API with --api-url or SAMVA_API_URL.`,
      });
    }
    return yield* Schema.decodeUnknownEffect(ConfigSchema)(rawValue).pipe(
      Effect.mapError(
        () =>
          new CliConfigError({
            code: "invalid_config",
            message: `Could not parse CLI config at ${file}. Fix or delete it.`,
          }),
      ),
    );
  });

/** Only the one key this check reads; every other key is the full schema's to judge. */
const StoredProfileTargets = Schema.Struct({
  profiles: Schema.Record(
    Schema.String,
    Schema.Struct({ target: Schema.optionalKey(Schema.Unknown) }),
  ),
});
const decodeStoredProfileTargets = Schema.decodeUnknownOption(StoredProfileTargets);

const profileWithTarget = (rawValue: unknown): string | undefined =>
  Option.match(decodeStoredProfileTargets(rawValue), {
    onNone: () => undefined,
    onSome: ({ profiles }) =>
      Object.entries(profiles).find(([, profile]) => Object.hasOwn(profile, "target"))?.[0],
  });

export const readConfig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* configFilePath;
  if (!(yield* fs.exists(file))) return emptyConfig;
  return yield* parseConfig(yield* fs.readFileString(file), file);
});

export const writeConfig = Effect.fn("CliConfig.writeConfig")(function* (config: SamvaConfig) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(yield* configDir, { recursive: true });
  yield* fs.writeFileString(yield* configFilePath, `${JSON.stringify(config, null, 2)}\n`);
});

/** Resolve flags/profile/API URL/identity without reading or decoding a secret. */
export const resolveExecutionSelection = Effect.gen(function* () {
  const profileFlag = Option.getOrUndefined(yield* Profile);
  const apiUrlFlag = Option.getOrUndefined(yield* ApiUrl);
  const orgFlag = Option.getOrUndefined(yield* Org);
  const config = yield* readConfig;
  const profile = profileFlag ?? SAMVA_PROFILE ?? config.activeProfile ?? "default";
  if (profile !== "default" && !Object.hasOwn(config.profiles, profile)) {
    return yield* new CliConfigError({
      code: "unknown_profile",
      message: `Profile ${profile} does not exist. Create it with \`samva profile create ${profile}\`.`,
    });
  }
  const stored = config.profiles[profile] ?? { credentialIdentity: "none" as const };
  const apiUrl = apiUrlFlag ?? SAMVA_API_URL ?? DEFAULT_API_URL;
  const orgSlug = orgFlag ?? SAMVA_ORG ?? stored.orgSlug;
  const apiKey = SAMVA_API_KEY && SAMVA_API_KEY.length > 0 ? SAMVA_API_KEY : undefined;

  if (apiKey && (orgFlag !== undefined || SAMVA_ORG !== undefined)) {
    return yield* new CliAuthError({
      code: "api_key_org_override",
      message: "--org/SAMVA_ORG cannot override an organization-scoped SAMVA_API_KEY.",
    });
  }

  // An explicit API key overrides only credentials; the API URL still follows
  // flags > env > default.
  if (apiKey) {
    return {
      profile,
      apiUrl,
      apiKey,
    } satisfies ExecutionSelection;
  }

  return {
    profile,
    apiUrl,
    orgSlug,
    profileOrgSlug: stored.orgSlug,
    apiKey,
  } satisfies ExecutionSelection;
});

export const resolveExecutionContext = Effect.gen(function* () {
  const selection = yield* resolveExecutionSelection;
  // API keys deliberately win without touching an OAuth keyring entry. This
  // keeps CI independent from a stale or malformed interactive login.
  if (selection.apiKey) {
    return { ...selection, credentials: undefined } satisfies ExecutionContext;
  }
  const config = yield* readConfig;
  const stored = config.profiles[selection.profile] ?? { credentialIdentity: "none" as const };
  const rawCredentials =
    stored.credentialIdentity === "oauth"
      ? yield* (yield* Keyring.Service).read(selection.profile)
      : undefined;
  const credentials = rawCredentials
    ? yield* decodeStoredCredentials(selection.profile, rawCredentials)
    : undefined;
  return {
    ...selection,
    credentials,
  } satisfies ExecutionContext;
});

/** Decode a keyring payload only after its non-secret profile selection is fixed. */
export const decodeStoredCredentials = (profile: string, rawCredentials: string) =>
  Effect.try({
    try: () => JSON.parse(rawCredentials) as unknown,
    catch: () =>
      new CliConfigError({
        code: "invalid_credential_record",
        message: `Stored credentials for profile ${profile} are invalid. Run \`samva logout\` then \`samva login\`.`,
      }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(CredentialsSchema)),
    Effect.mapError(
      () =>
        new CliConfigError({
          code: "invalid_credential_record",
          message: `Stored credentials for profile ${profile} are invalid. Run \`samva logout\` then \`samva login\`.`,
        }),
    ),
  );

/** URL-only callers must not decode credentials before they begin recovery. */
export const resolveApiUrl = Effect.map(resolveExecutionSelection, (selection) => selection.apiUrl);

/**
 * OAuth access tokens carry a second-resolution expiry. Compared against the
 * Effect `Clock` (not `Date.now`) so the check is deterministic under TestClock.
 */
export const isCredentialExpired = (credentials: SamvaCredentials, nowMillis: number): boolean =>
  credentials.expiresAt <= Math.floor(nowMillis / 1000);

export const writeCredentials = Effect.fn("CliConfig.writeCredentials")(function* (
  credentials: SamvaCredentials,
) {
  const context = yield* resolveExecutionSelection;
  const config = yield* readConfig;
  // A brand-new profile record carries no org: `context.orgSlug` here may be a
  // one-shot `--org`/`SAMVA_ORG` override, which must not be persisted. The
  // active org is set explicitly via `samva org use`.
  const current = config.profiles[context.profile] ?? { credentialIdentity: "none" as const };
  yield* writeConfig({
    ...config,
    profiles: {
      ...config.profiles,
      [context.profile]: { ...current, credentialIdentity: "oauth" },
    },
  });
  yield* (yield* Keyring.Service).write(context.profile, JSON.stringify(credentials));
});

export const readCredentials = Effect.map(
  resolveExecutionContext,
  (context) => context.credentials,
);

export const clearCredentials = Effect.gen(function* () {
  const context = yield* resolveExecutionSelection;
  const config = yield* readConfig;
  const current = config.profiles[context.profile];
  if (!current || current.credentialIdentity === "none") return;
  yield* writeConfig({
    ...config,
    profiles: {
      ...config.profiles,
      [context.profile]: { ...current, credentialIdentity: "none" },
    },
  });
  yield* (yield* Keyring.Service).clear(context.profile);
});
