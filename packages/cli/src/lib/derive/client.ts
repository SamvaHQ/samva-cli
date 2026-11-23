import { Authorization } from "@samva/contracts/http-api";
import { SamvaSdkAuthenticatedApi } from "@samva/contracts/sdk-api";
import type { PublicOperation } from "@samva/contracts/surface/operations";
import { Effect, Predicate } from "effect";
import { HttpApiClient, HttpApiMiddleware } from "effect/http-api";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { CliTimeoutError, SamvaCliError, toCliApiError } from "../../errors";
import { getClientConfig, requestAuthHeaders } from "../client";

export interface DerivedRequest {
  readonly params?: Readonly<Record<string, unknown>>;
  readonly query?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, unknown>>;
  readonly payload?: unknown;
}

type Endpoint = (request: DerivedRequest) => Effect.Effect<unknown, unknown>;

type Group = keyof typeof SamvaSdkAuthenticatedApi.groups;

// The transport already sets the credential and organization headers for both auth modes.
const authorizationClient = HttpApiMiddleware.layerClient(Authorization, ({ next, request }) =>
  next(request),
);

type Operation = Pick<PublicOperation, "operationId" | "group" | "endpoint">;

export const derivedClient = Effect.fn("CliDerived.client")(function* (
  operation: Operation,
  failureMessage = `Could not run ${operation.operationId}`,
) {
  if (!Object.hasOwn(SamvaSdkAuthenticatedApi.groups, operation.group))
    return yield* new SamvaCliError({ message: `Unknown group ${operation.group}` });

  const config = yield* getClientConfig;
  const transport = yield* HttpClient.HttpClient;
  const endpoints: Readonly<Record<string, unknown>> = yield* HttpApiClient.group(
    SamvaSdkAuthenticatedApi,
    {
      baseUrl: config.baseUrl,
      group: operation.group as Group,
      httpClient: transport.pipe(
        HttpClient.mapRequest(HttpClientRequest.setHeaders(requestAuthHeaders(config))),
      ),
    },
  ).pipe(Effect.provide(authorizationClient));

  // The descriptor supplies the matching group, endpoint, and request codecs at runtime.
  const call = endpoints[operation.endpoint];
  if (typeof call !== "function")
    return yield* new SamvaCliError({ message: `Unknown endpoint ${operation.operationId}` });

  return (request: DerivedRequest) =>
    (call as Endpoint)(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.mapError((error) =>
        Predicate.isObject(error) && error._tag === "GatewayTimeoutError"
          ? new CliTimeoutError({
              code: "request_timeout",
              message:
                typeof error.message === "string" ? error.message : "The API request timed out.",
            })
          : toCliApiError(failureMessage, error),
      ),
    );
});
