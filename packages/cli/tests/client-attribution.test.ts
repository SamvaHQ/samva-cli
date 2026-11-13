import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { CliAuthError } from "../src/errors";
import { CLI_VERSION } from "../src/lib/client-attribution";
import { getText } from "../src/lib/http";
import { listOrganizations, requestDeviceCode, revokeSession } from "../src/lib/oauth";

const requestHeaders = (input: URL | RequestInfo, init?: RequestInit): Headers =>
  input instanceof Request ? input.headers : new Headers(init?.headers);

afterEach(() => vi.unstubAllGlobals());

describe("CLI client attribution", () => {
  it.effect("covers the direct health request", () =>
    Effect.gen(function* () {
      const seen: Array<Headers> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((input: URL | RequestInfo, init?: RequestInit) => {
          seen.push(requestHeaders(input, init));
          return Promise.resolve(new Response("ok"));
        }),
      );

      yield* getText("https://api.test/v1/health/ping");

      expect(seen.map((headers) => headers.get("x-samva-client"))).toEqual([`cli/${CLI_VERSION}`]);
    }),
  );

  it.effect("covers the unauthenticated device-authorization request", () =>
    Effect.gen(function* () {
      const seen: Array<Headers> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((input: URL | RequestInfo, init?: RequestInit) => {
          seen.push(requestHeaders(input, init));
          return Promise.resolve(
            new Response(
              JSON.stringify({
                device_code: "device-code",
                user_code: "ABCD-EFGH",
                verification_uri: "https://samva.dev/device",
                expires_in: 900,
                interval: 5,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }),
      );

      yield* requestDeviceCode("https://api.test");

      expect(seen).toHaveLength(1);
      expect(seen[0]?.get("x-samva-client")).toBe(`cli/${CLI_VERSION}`);
      expect(seen[0]?.get("authorization")).toBeNull();
    }),
  );

  it.effect("covers OAuth requests that carry their own authorization headers", () =>
    Effect.gen(function* () {
      const seen: Array<Headers> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((input: URL | RequestInfo, init?: RequestInit) => {
          seen.push(requestHeaders(input, init));
          return Promise.resolve(
            new Response(seen.length === 1 ? undefined : "[]", {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }),
      );

      yield* revokeSession("https://api.test", "token");
      yield* listOrganizations("https://api.test", "token");

      for (const headers of seen) {
        expect(headers.get("x-samva-client")).toBe(`cli/${CLI_VERSION}`);
        expect(headers.get("authorization")).toBe("Bearer token");
      }
    }),
  );
});

describe("user-scoped organization list", () => {
  it.effect("asks for a new login when the server has ended the session", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(Response.json({ message: "Unauthorized" }, { status: 401 }))),
      );

      const error = yield* Effect.flip(listOrganizations("https://api.test", "ended_session"));

      expect(error).toBeInstanceOf(CliAuthError);
      expect(error).toMatchObject({ code: "expired_credentials" });
    }),
  );
});
