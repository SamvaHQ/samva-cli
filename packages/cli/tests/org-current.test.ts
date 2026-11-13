import { createServer, type AddressInfo } from "node:http";

import * as BunServices from "@effect/platform-bun/BunServices";
import { afterEach, beforeEach, expect, it, vi } from "@effect/vitest";
import * as Command from "effect/cli/Command";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { TestConsole } from "effect/testing";

import { orgCommand } from "../src/commands/org";
import { Keyring } from "../src/config/credential-store";
import { ApiUrl, Json, JsonLines, Org, Profile } from "../src/lib/runtime";

beforeEach(() => {
  vi.stubEnv("SAMVA_API_KEY", "");
  vi.stubEnv("SAMVA_PROFILE", "");
  vi.stubEnv("SAMVA_ORG", "");
});
afterEach(() => vi.unstubAllEnvs());

it("reads the hosted domain for OAuth with the selected organization header", async () => {
  let keyringReads = 0;
  const requests: Array<{
    url: string | undefined;
    authorization: string | undefined;
    org: string | string[] | undefined;
  }> = [];
  const server = createServer((request, response) => {
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      org: request.headers["x-org-slug"],
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        organization: {
          id: "org_3m8p2vqz6ty4bnkd",
          slug: "renamed-org",
          name: "Renamed",
          hostedMailDomain: "original.samva.email",
        },
        credential: {
          type: "user",
          user: { id: "user_123", name: "Owner", email: "owner@example.com" },
          role: "owner",
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const originalArgv = process.argv;
  process.argv = [...originalArgv, "--json"];
  try {
    const { port } = server.address() as AddressInfo;
    const logs = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Command.runWith(orgCommand, { version: "test" })(["current", "--json"]);
        return yield* TestConsole.logLines;
      }).pipe(
        Effect.provideService(Profile, Option.none()),
        Effect.provideService(ApiUrl, Option.some(`http://127.0.0.1:${port}`)),
        Effect.provideService(Org, Option.some("renamed-org")),
        Effect.provideService(Json, true),
        Effect.provideService(JsonLines, false),
        Effect.provideService(Keyring.Service, {
          read: () =>
            Effect.sync(() => {
              keyringReads += 1;
              return JSON.stringify({
                accessToken: "oauth-test",
                tokenType: "bearer",
              });
            }),
          write: () => Effect.die("Unexpected credential write"),
          clear: () => Effect.die("Unexpected credential removal"),
        }),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            exists: () => Effect.succeed(true),
            readFileString: () =>
              Effect.succeed(
                JSON.stringify({
                  version: 2,
                  profiles: { default: { credentialIdentity: "oauth" } },
                }),
              ),
          }),
        ),
        Effect.provide(Path.layer),
        Effect.provide(TestConsole.layer),
        Effect.provide(BunServices.layer),
      ),
    );
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      activeOrgSlug: "renamed-org",
      organization: { hostedMailDomain: "original.samva.email" },
      credential: { type: "user", id: "user_123", name: "Owner" },
    });
    expect(keyringReads).toBe(1);
    expect(requests).toEqual([
      { url: "/v1/whoami", authorization: "Bearer oauth-test", org: "renamed-org" },
    ]);
  } finally {
    process.argv = originalArgv;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
