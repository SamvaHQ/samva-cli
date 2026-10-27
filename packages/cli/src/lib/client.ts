import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Client from "samva/effect/client";

import {
  type ExecutionContext,
  isCredentialExpired,
  resolveExecutionContext,
} from "../config/store";
import { CliAuthError, SamvaCliError, toCliApiError } from "../errors";
import { CLI_CLIENT_HEADERS } from "./client-attribution";

const missingOrgMessage =
  "No active organization. Run `samva org use <slug>` after `samva login`, or use SAMVA_API_KEY for single-org automation.";

interface ClientProvider {
  readonly provide: <A, E>(effect: Effect.Effect<A, E, Client.Service>) => Effect.Effect<A, E>;
}

const provider = (config: Client.Config): ClientProvider => ({
  provide: (effect) => Effect.provide(effect, Client.layerFetch(config)),
});

/** Resolve SDK configuration shared with authenticated requests outside the SDK. */
const getClientConfigForContext = (context: ExecutionContext, baseUrl: string) =>
  Effect.gen(function* () {
    if (context.apiKey) {
      return {
        apiKey: context.apiKey,
        baseUrl,
        headers: CLI_CLIENT_HEADERS,
      } satisfies Client.Config;
    }

    if (context.credentials) {
      if (isCredentialExpired(context.credentials, yield* Clock.currentTimeMillis)) {
        return yield* new CliAuthError({
          code: "expired_credentials",
          message: "Your session has expired. Run `samva login` to sign in again.",
        });
      }
      const authToken = context.credentials.accessToken;
      const activeOrgSlug = context.orgSlug;
      if (!activeOrgSlug) {
        return yield* new CliAuthError({
          code: "missing_organization",
          message: missingOrgMessage,
        });
      }
      return {
        authToken,
        baseUrl,
        headers: { ...CLI_CLIENT_HEADERS, "x-org-slug": activeOrgSlug },
      } satisfies Client.Config;
    }

    return yield* new CliAuthError({
      code: "missing_credentials",
      message: "No credentials found. Run `samva login`, or set SAMVA_API_KEY for automation.",
    });
  });

/**
 * Headers for an authenticated request made outside the SDK: the client attribution and
 * organization headers, plus `x-api-key` for an API key or `Authorization: Bearer` for OAuth.
 */
export const requestAuthHeaders = (config: Client.Config): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(config.headers ?? {})) {
    if (value !== undefined) headers[name] = value;
  }
  if (config.apiKey !== undefined) {
    headers["x-api-key"] = Redacted.isRedacted(config.apiKey)
      ? Redacted.value(config.apiKey)
      : config.apiKey;
  } else {
    headers["Authorization"] = `Bearer ${config.authToken}`;
  }
  return headers;
};

/**
 * Build an authenticated Samva SDK operation provider. This is the single seam all command
 * handlers go through. `SAMVA_API_KEY` takes precedence over stored OAuth
 * credentials. OAuth is the interactive fallback; its user-scoped token sends
 * the active org (`samva org use`) as the `x-org-slug` header.
 */
export const getClientConfig = Effect.flatMap(resolveExecutionContext, (context) =>
  getClientConfigForContext(context, context.apiUrl),
);

/** Build an authenticated SDK operation provider for an explicit execution context. */
export const getClientProviderForContext = (context: ExecutionContext) =>
  Effect.map(getClientConfigForContext(context, context.apiUrl), provider);

export const getClientProvider = Effect.map(getClientConfig, provider);

/** A JSON request body and its extra headers, for an API call the generated SDK omits. */
export interface JsonRequestBody {
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** The HTTP method; POST when omitted. */
  readonly method?: "POST" | "PUT";
}

/** Fetch an authenticated API resource omitted from the generated SDK, for an explicit context. */
export const getAuthenticatedJsonForContext = Effect.fn("CliClient.getAuthenticatedJson")(
  function* (context: ExecutionContext, path: string, request?: JsonRequestBody) {
    const config = yield* getClientConfigForContext(context, context.apiUrl);
    const headers = {
      ...(request === undefined ? {} : { "content-type": "application/json", ...request.headers }),
      ...requestAuthHeaders(config),
    };
    const url = `${config.baseUrl.replace(/\/$/, "")}${path}`;
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(
          url,
          request === undefined
            ? { headers, signal }
            : {
                method: request.method ?? "POST",
                headers,
                body: JSON.stringify(request.body),
                signal,
              },
        ),
      catch: (cause) =>
        new SamvaCliError({ message: `Request to ${url} failed: ${String(cause)}` }),
    });
    const body = yield* Effect.tryPromise({
      try: (): Promise<unknown> => response.json(),
      catch: (cause) =>
        new SamvaCliError({
          message: `Request to ${url} failed: HTTP ${response.status}, unreadable body: ${String(cause)}`,
        }),
    });
    if (response.ok) return body;
    // A tagged API error keeps its message, status, and recovery fields.
    return yield* Predicate.isObject(body) && typeof body._tag === "string"
      ? toCliApiError(`Request to ${url} failed`, body)
      : new SamvaCliError({ message: `Request to ${url} failed: HTTP ${response.status}` });
  },
);

/** Fetch an authenticated API resource omitted from the generated SDK. */
export const getAuthenticatedJson = (path: string) =>
  Effect.flatMap(resolveExecutionContext, (context) =>
    getAuthenticatedJsonForContext(context, path),
  );

/** Send JSON (POST, or PUT when the request says so) to an authenticated resource the SDK omits. */
export const postAuthenticatedJson = (path: string, request: JsonRequestBody) =>
  Effect.flatMap(resolveExecutionContext, (context) =>
    getAuthenticatedJsonForContext(context, path, request),
  );
