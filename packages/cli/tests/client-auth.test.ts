import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Templates from "samva/effect/templates";

import type { ExecutionContext } from "../src/config/store";
import { CliAuthError, processErrorCode, processErrorReason } from "../src/errors";
import { getAuthenticatedJsonForContext, getClientProviderForContext } from "../src/lib/client";

afterEach(() => vi.unstubAllGlobals());

describe("authenticated API requests outside the SDK", () => {
  for (const auth of [
    { apiKey: "samva_test_key" },
    {
      credentials: { accessToken: "oauth_token", tokenType: "bearer", expiresAt: 4_000_000_000 },
      orgSlug: "acme",
    },
  ]) {
    it.effect(`matches SDK headers for ${"apiKey" in auth ? "API keys" : "OAuth"}`, () =>
      Effect.gen(function* () {
        const context: ExecutionContext = {
          profile: "default",
          apiUrl: "https://api.test/proxy/",
          ...auth,
        };
        const seen: Request[] = [];
        vi.stubGlobal(
          "fetch",
          vi.fn((input: URL | RequestInfo, init?: RequestInit) => {
            const request = new Request(input, init);
            seen.push(request);
            return Promise.resolve(
              Response.json({
                items: [],
                nextCursor: null,
              }),
            );
          }),
        );

        yield* getAuthenticatedJsonForContext(context, "/v1/starters/");
        const client = yield* getClientProviderForContext(context);
        yield* Templates.list({}).pipe(
          client.provide,
          Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
        );

        expect(seen[0]?.url).toBe("https://api.test/proxy/v1/starters/");
        for (const header of ["x-api-key", "authorization", "x-org-slug", "x-samva-client"]) {
          expect(seen[0]?.headers.get(header)).toBe(seen[1]?.headers.get(header));
        }
        if ("apiKey" in auth) expect(seen[0]?.headers.get("x-api-key")).toBe(auth.apiKey);
        else {
          expect(seen[0]?.headers.get("authorization")).toBe("Bearer oauth_token");
          expect(seen[0]?.headers.get("x-org-slug")).toBe("acme");
        }
      }),
    );
  }

  it.effect("refuses expired OAuth credentials before fetching", () =>
    Effect.gen(function* () {
      const context: ExecutionContext = {
        profile: "default",
        apiUrl: "https://api.test",
        orgSlug: "acme",
        credentials: { accessToken: "expired", tokenType: "bearer", expiresAt: 0 },
      };
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);

      const error = yield* Effect.flip(getAuthenticatedJsonForContext(context, "/v1/starters/"));
      expect(error).toBeInstanceOf(CliAuthError);
      expect(error).toMatchObject({ code: "expired_credentials" });
      expect(fetch).not.toHaveBeenCalled();
    }),
  );
  it.effect("keeps a tagged API error's message, status, and exit code", () =>
    Effect.gen(function* () {
      const context: ExecutionContext = {
        profile: "default",
        apiUrl: "https://api.test",
        apiKey: "samva_expired_key",
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(
            Response.json(
              { _tag: "UnauthorizedError", message: "This API key has expired." },
              { status: 401 },
            ),
          ),
        ),
      );

      const error = yield* Effect.flip(getAuthenticatedJsonForContext(context, "/v1/starters/"));
      expect(error.message).toBe("This API key has expired.");
      expect(processErrorReason(error)).toBe("UnauthorizedError");
      expect(processErrorCode(error)).toBe(4);
    }),
  );
});
