/** Bun-side WebSocket fixture; the CLI Vitest project itself runs under Node. */
import {
  MAILBOX_EVENT_STREAM_PONG_FRAME,
  MailboxEventStreamClientFrame,
} from "@samva/core/mailboxes/event-stream";
import { Schema } from "effect";

const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(MailboxEventStreamClientFrame));
interface Scenario {
  frames?: unknown[];
  refusal?: number;
  /** The refusal body: an API error object, or a string sent as text. Default: the status's tag. */
  refusalBody?: unknown;
  close?: number;
  /**
   * Drop the connection after the frames with no close frame, as a network failure does. A number
   * drops only that many connections; later ones stay open.
   */
  terminate?: boolean | number;
  /** The frames sent on every connection after the first, in place of `frames`. */
  reconnectFrames?: unknown[];
  /** The close code sent on every connection after the first, in place of `close`. */
  reconnectClose?: number;
  closeAfterAck?: boolean;
}
/** The API error tag the events Worker answers each refusal status with. */
const refusalTags: Record<number, string> = {
  401: "UnauthorizedError",
  403: "ForbiddenError",
  404: "ResourceNotFoundError",
  405: "MethodNotAllowedError",
  410: "CursorExpiredError",
  422: "ValidationError",
  426: "UpgradeRequiredError",
  429: "RateLimitedError",
  503: "ServiceUnavailableError",
};
let scenario: Scenario = {};
let handshakes: Array<{ url: string; headers: Record<string, string> }> = [];
let acks: unknown[] = [];
let closes: Array<{ code: number; reason: string }> = [];
let opened = 0;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request, runtimeServer) => {
    const url = new URL(request.url);
    if (url.pathname === "/scenario") {
      scenario = await request.json();
      handshakes = [];
      acks = [];
      closes = [];
      opened = 0;
      return Response.json({ ok: true });
    }
    if (url.pathname === "/state") return Response.json({ handshakes, acks, closes });
    handshakes.push({ url: request.url, headers: Object.fromEntries(request.headers) });
    if (scenario.refusal) {
      const body = scenario.refusalBody ?? {
        _tag: refusalTags[scenario.refusal] ?? "InternalError",
        message: "Refused",
        ...(scenario.refusal === 429 ? { retryAfterSeconds: 1 } : {}),
      };
      return typeof body === "string"
        ? new Response(body, { status: scenario.refusal })
        : Response.json(body, { status: scenario.refusal });
    }
    if (runtimeServer.upgrade(request)) return;
    return new Response("Upgrade required", { status: 426 });
  },
  websocket: {
    open: (socket) => {
      opened += 1;
      const frames =
        opened > 1 && scenario.reconnectFrames ? scenario.reconnectFrames : scenario.frames;
      for (const frame of frames ?? [])
        socket.send(typeof frame === "string" ? frame : JSON.stringify(frame));
      const close =
        opened > 1 && scenario.reconnectClose ? scenario.reconnectClose : scenario.close;
      if (close) socket.close(close, "Scripted close");
      const drops = scenario.terminate === true ? Infinity : scenario.terminate || 0;
      if (opened <= drops) setTimeout(() => socket.terminate(), 100);
    },
    message: (socket, raw) => {
      const frame = decodeFrame(String(raw));
      if (frame.kind === "ping") return void socket.send(MAILBOX_EVENT_STREAM_PONG_FRAME);
      acks.push(frame);
      if (scenario.closeAfterAck) socket.close(1000);
    },
    close: (_socket, code, reason) => {
      closes.push({ code, reason });
    },
  },
});
console.log(server.url.origin);
process.on("SIGTERM", () => {
  server.stop(true);
  process.exit(0);
});
