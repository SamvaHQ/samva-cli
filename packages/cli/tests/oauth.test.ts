import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { CliAuthError, CliTimeoutError } from "../src/errors";
import { browserLaunchCommand, pollForToken, requestDeviceCode } from "../src/lib/oauth";

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const stubTokenResponses = (responses: Array<Response>) => {
  const fetchMock = vi.fn(() =>
    Promise.resolve(responses.shift() ?? jsonResponse(500, { error: "exhausted_stub" })),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

/** Let the fiber consume a resolved fetch promise and register its next sleep. */
const drain = Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, 0)));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pollForToken", () => {
  it.effect("polls on the interval and grows it by 5s on slow_down (RFC 8628 §3.5)", () =>
    Effect.gen(function* () {
      const fetchMock = stubTokenResponses([
        jsonResponse(400, { error: "authorization_pending" }),
        jsonResponse(400, { error: "slow_down" }),
        jsonResponse(400, { error: "authorization_pending" }),
        jsonResponse(200, { access_token: "tok_1", token_type: "bearer", expires_in: 3600 }),
      ]);

      const fiber = yield* Effect.forkChild(pollForToken("https://api.test", "dev-code", 5, 1800));

      // No poll before the first interval elapses.
      yield* drain;
      expect(fetchMock).toHaveBeenCalledTimes(0);

      yield* TestClock.adjust("5 seconds");
      yield* drain;
      expect(fetchMock).toHaveBeenCalledTimes(1); // t=5 → authorization_pending

      yield* TestClock.adjust("5 seconds");
      yield* drain;
      expect(fetchMock).toHaveBeenCalledTimes(2); // t=10 → slow_down (interval → 10s)

      yield* TestClock.adjust("5 seconds");
      yield* drain;
      expect(fetchMock).toHaveBeenCalledTimes(2); // t=15 — only 5s of the 10s interval

      yield* TestClock.adjust("5 seconds");
      yield* drain;
      expect(fetchMock).toHaveBeenCalledTimes(3); // t=20 → authorization_pending

      yield* TestClock.adjust("10 seconds");
      yield* drain;
      const token = yield* Fiber.join(fiber); // t=30 → success
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(token.access_token).toBe("tok_1");
    }),
  );

  it.effect("fails with the timeout message once expires_in elapses", () =>
    Effect.gen(function* () {
      stubTokenResponses([
        jsonResponse(400, { error: "authorization_pending" }),
        jsonResponse(400, { error: "authorization_pending" }),
        jsonResponse(400, { error: "authorization_pending" }),
      ]);

      const fiber = yield* Effect.forkChild(
        pollForToken("https://api.test", "dev-code", 5, 12).pipe(Effect.flip),
      );

      yield* TestClock.adjust("5 seconds");
      yield* drain;
      yield* TestClock.adjust("5 seconds");
      yield* drain;
      yield* TestClock.adjust("2 seconds");
      yield* drain;

      const error = yield* Fiber.join(fiber);
      expect(error).toBeInstanceOf(CliTimeoutError);
      expect(error.code).toBe("login_timeout");
      expect(error.message).toBe("Login timed out. Run `samva login` again.");
    }),
  );

  it.effect("access_denied is terminal — no further polls", () =>
    Effect.gen(function* () {
      const fetchMock = stubTokenResponses([jsonResponse(400, { error: "access_denied" })]);

      const fiber = yield* Effect.forkChild(
        pollForToken("https://api.test", "dev-code", 5, 1800).pipe(Effect.flip),
      );

      yield* TestClock.adjust("5 seconds");
      yield* drain;

      const error = yield* Fiber.join(fiber);
      expect(error).toBeInstanceOf(CliAuthError);
      expect(error.code).toBe("authorization_denied");
      expect(error.message).toBe("Login was denied in the browser.");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("expired_token maps to the timeout contract", () =>
    Effect.gen(function* () {
      stubTokenResponses([jsonResponse(400, { error: "expired_token" })]);

      const fiber = yield* Effect.forkChild(
        pollForToken("https://api.test", "dev-code", 1, 30).pipe(Effect.flip),
      );

      yield* TestClock.adjust("1 second");
      yield* drain;

      const error = yield* Fiber.join(fiber);
      expect(error).toBeInstanceOf(CliTimeoutError);
      expect(error.code).toBe("login_timeout");
    }),
  );
});

describe("device authorization boundary", () => {
  it("rejects a non-HTTPS verification URL from the authorization server", async () => {
    stubTokenResponses([
      jsonResponse(200, {
        device_code: "device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "file:///tmp/payload",
        expires_in: 900,
        interval: 5,
      }),
    ]);

    const exit = await Effect.runPromiseExit(requestDeviceCode("https://api.samva.test"));

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toContain("Unexpected response from device/code");
    }
  });

  it("rejects non-positive device authorization durations", async () => {
    for (const response of [
      { expires_in: 0, interval: 5 },
      { expires_in: -1, interval: 5 },
      { expires_in: 900, interval: 0 },
      { expires_in: 900, interval: -1 },
    ]) {
      stubTokenResponses([
        jsonResponse(200, {
          device_code: "device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://samva.dev/device",
          ...response,
        }),
      ]);

      const exit = await Effect.runPromiseExit(requestDeviceCode("https://api.samva.test"));

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain("Unexpected response from device/code");
      }
    }
  });

  it("accepts forward-compatible device authorization fields", async () => {
    stubTokenResponses([
      jsonResponse(200, {
        device_code: "device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://samva.dev/device",
        expires_in: 900,
        interval: 5,
        server_hint: "future-extension",
      }),
    ]);

    const response = await Effect.runPromise(requestDeviceCode("https://api.samva.test"));

    expect(response).toEqual({
      device_code: "device-code",
      user_code: "ABCD-EFGH",
      verification_uri: "https://samva.dev/device",
      expires_in: 900,
      interval: 5,
    });
  });

  it("opens Windows browsers without routing the URL through cmd.exe", () => {
    expect(browserLaunchCommand("https://samva.dev/device?user_code=1&calc.exe", "win32")).toEqual([
      "rundll32.exe",
      ["url.dll,FileProtocolHandler", "https://samva.dev/device?user_code=1&calc.exe"],
    ]);
    expect(browserLaunchCommand("file:///tmp/payload", "win32")).toBeUndefined();
  });
});
