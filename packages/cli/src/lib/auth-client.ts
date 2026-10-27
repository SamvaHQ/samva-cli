import { createAuthClient } from "better-auth/client";
import { deviceAuthorizationClient, organizationClient } from "better-auth/client/plugins";

import { CLI_CLIENT_HEADERS } from "./client-attribution";

/**
 * Better Auth client for the endpoints the `samva` SDK does not cover: the
 * OAuth device-authorization flow, sign-out, and the user-scoped organization
 * list. The plugins mirror the server instance, so request bodies, response
 * shapes, and error codes come from Better Auth's own types.
 *
 * The client is built per call rather than once per process: `createAuthClient`
 * captures the ambient `fetch`, and the CLI's credential and API URL are
 * resolved per command.
 */
export const createCliAuthClient = (apiUrl: string, accessToken?: string) =>
  createAuthClient({
    // Samva mounts Better Auth under `/v1/auth`, not the `/api/auth` default.
    baseURL: `${apiUrl}/v1/auth`,
    plugins: [deviceAuthorizationClient(), organizationClient()],
    fetchOptions: {
      headers: {
        ...CLI_CLIENT_HEADERS,
        // The CLI's access token is a Better Auth session token; the server's
        // `bearer()` plugin accepts it in place of the session cookie.
        ...(accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` }),
      },
    },
  });
