import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * A fake API server whose handler may await the request body. Node's request listener returns
 * `void`, so a rejected handler would otherwise escape as an unhandled rejection; destroying the
 * response fails the request the test is waiting on instead.
 */
export const createTestServer = (
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): Server =>
  createServer((request, response) => {
    void handler(request, response).catch((failure: unknown) => {
      response.destroy(failure instanceof Error ? failure : undefined);
    });
  });
