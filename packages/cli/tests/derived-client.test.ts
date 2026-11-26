import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Option, Path } from "effect";
import { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";

import { Keyring } from "../src/config/credential-store";
import { derivedClient } from "../src/lib/derive/client";
import { ApiUrl, Org, Profile } from "../src/lib/runtime";

it.effect("interrupts a stalled derived request at the SDK attempt deadline", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const transport = HttpClient.make(() =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      ),
    );
    const call = yield* derivedClient({
      group: "contacts",
      endpoint: "list",
      operationId: "contacts.list",
    }).pipe(Effect.provideService(HttpClient.HttpClient, transport));
    const fiber = yield* Effect.forkChild(call({ query: {} }).pipe(Effect.flip));
    yield* Deferred.await(started);
    yield* TestClock.adjust("30 seconds");
    expect(yield* Fiber.join(fiber)).toMatchObject({
      _tag: "CliTimeoutError",
      code: "request_timeout",
    });
    yield* Deferred.await(interrupted);
  }).pipe(
    Effect.provideService(Profile, Option.some("default")),
    Effect.provideService(ApiUrl, Option.some("https://api.samva.test")),
    Effect.provideService(Org, Option.none()),
    Effect.provideService(Keyring.Service, {
      read: () => Effect.succeed(JSON.stringify({ accessToken: "fixture", tokenType: "bearer" })),
      write: () => Effect.die("Unexpected keyring write"),
      clear: () => Effect.die("Unexpected keyring clear"),
    }),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        readFileString: () =>
          Effect.succeed(
            JSON.stringify({
              version: 2,
              profiles: { default: { credentialIdentity: "oauth", orgSlug: "fixture" } },
            }),
          ),
      }),
    ),
    Effect.provide(Path.layer),
  ),
);
