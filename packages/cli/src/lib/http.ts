import * as Effect from "effect/Effect";

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

export const getText = (url: string): Effect.Effect<HttpResult, SamvaCliError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url, { headers: CLI_CLIENT_HEADERS });
      return { ok: res.ok, status: res.status, body: await res.text() };
    },
    catch: (cause) => new SamvaCliError({ message: `Request to ${url} failed: ${String(cause)}` }),
  });
