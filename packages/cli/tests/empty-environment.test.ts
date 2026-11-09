/** An empty environment variable is an unset one, wherever the CLI reads it. */
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { vi } from "vitest";

import type { SamvaConfig } from "../src/config/store";

const stubEmpty = (names: ReadonlyArray<string>) => {
  vi.resetModules();
  for (const name of names) vi.stubEnv(name, "");
};

const select = async (config: SamvaConfig) => {
  // Same module registry as the store, so the flag services are the ones it reads.
  const { resolveExecutionSelection } = await import("../src/config/store");
  const { ApiUrl, Org, Profile } = await import("../src/lib/runtime");
  return resolveExecutionSelection.pipe(
    Effect.provideService(Profile, Option.none()),
    Effect.provideService(ApiUrl, Option.none()),
    Effect.provideService(Org, Option.none()),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        readFileString: () => Effect.succeed(JSON.stringify(config)),
      }),
    ),
    Effect.provide(Path.layer),
    Effect.runPromise,
  );
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("empty environment overrides", () => {
  it("falls back to the default API URL", async () => {
    stubEmpty(["SAMVA_API_URL", "SAMVA_API_KEY"]);
    const selection = await select({ version: 2, profiles: {} });
    expect(selection.apiUrl).toBe("https://api.samva.dev");
  });

  it("falls back to the active profile", async () => {
    stubEmpty(["SAMVA_PROFILE"]);
    const selection = await select({
      version: 2,
      activeProfile: "work",
      profiles: { work: { credentialIdentity: "none" } },
    });
    expect(selection.profile).toBe("work");
  });

  it("does not treat an empty organization as an override of an API key", async () => {
    stubEmpty(["SAMVA_ORG"]);
    vi.stubEnv("SAMVA_API_KEY", "sk_test_value");
    const selection = await select({ version: 2, profiles: {} });
    expect(selection).toMatchObject({ profile: "default", apiKey: "sk_test_value" });
  });
});
