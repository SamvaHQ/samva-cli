import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { SamvaCliError } from "../errors";
import { CLI_CLIENT_HEADERS } from "./client-attribution";

/**
 * Raw HTTP for the unauthenticated health checks (`/v1/health/*`) the `samva`
 * SDK does not (and should not) cover. **Product API calls always go through
 * the SDK** (see `lib/client`), and auth calls go through the Better Auth
 * client (see `lib/auth-client`) — never here.
 */
export interface HttpResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: string;
}

export const getText = (
  url: string,
): Effect.Effect<HttpResult, SamvaCliError, HttpClient.HttpClient> =>
  HttpClient.execute(
    HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(CLI_CLIENT_HEADERS)),
  ).pipe(
    Effect.flatMap((response) =>
      response.text.pipe(
        Effect.map((body) => ({
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          body,
        })),
      ),
    ),
    Effect.mapError(
      (cause) => new SamvaCliError({ message: `Request to ${url} failed: ${String(cause)}` }),
    ),
  );
