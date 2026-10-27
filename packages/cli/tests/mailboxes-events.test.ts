import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { MailboxEventStreamCloseCode } from "@samva/core/mailboxes/event-stream";

import { runCli, spawnCli } from "./support/run-cli";

// Never called: puts the spawned entries in this file's import graph for `vitest --changed`.
void (() => import("./oauth-runner.ts"));
void (() => import("./mailboxes-events-server.ts"));

const runner = fileURLToPath(new URL("./oauth-runner.ts", import.meta.url));
const serverRunner = fileURLToPath(new URL("./mailboxes-events-server.ts", import.meta.url));
let server: ChildProcessWithoutNullStreams;
let origin: string;
let home: string;
const mailbox = "mbx_1234567890123456";
const otherMailbox = "mbx_2345678901234567";
// The server owns the cursor's format; the CLI passes any string through untouched.
const opaqueCursor = "evc_Zm9vYmFyLTQy";
const event = (cursor: number) => ({
  kind: "event",
  cursor: String(cursor),
  id: "whevt_1234567890123456",
  event: {
    type: "mailbox.message.received",
    timestamp: "2026-10-06T00:00:00Z",
    data: { mailboxId: mailbox, sequence: cursor },
  },
});
interface State {
  handshakes: Array<{ url: string; headers: Record<string, string> }>;
  acks: Array<{ kind: string; cursor: string }>;
  closes: Array<{ code: number }>;
}
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "samva-mailbox-events-"));
  await mkdir(join(home, "samva"));
  await writeFile(
    join(home, "samva", "config.json"),
    JSON.stringify({
      version: 2,
      profiles: { default: { credentialIdentity: "oauth", orgSlug: "acme" } },
    }),
  );
  server = spawn("bun", ["--no-env-file", serverRunner], { stdio: "pipe" });
  origin = await new Promise<string>((resolve, reject) => {
    server.stdout.once("data", (data) => resolve(String(data).trim()));
    server.once("error", reject);
    server.once("exit", (code) => reject(new Error(`Bun WebSocket fixture exited (${code})`)));
  });
});
afterAll(async () => {
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => server.once("close", () => resolve()));
  await rm(home, { recursive: true });
});
const configure = async (scenario: unknown) => {
  const response = await fetch(`${origin}/scenario`, {
    method: "POST",
    body: JSON.stringify(scenario),
  });
  expect(response.ok).toBe(true);
};
const state = async (): Promise<State> => (await fetch(`${origin}/state`)).json();
const options = (oauth = false) => ({
  executable: "bun",
  configHome: home,
  env: {
    SAMVA_API_URL: "https://api.samva.dev",
    SAMVA_EVENTS_URL: origin,
    ...(oauth ? {} : { SAMVA_API_KEY: "sk_test_mailbox" }),
  },
});
const args = (extra: string[] = []) => ["--no-env-file", runner, "mailboxes", "events", ...extra];
const run = (extra: string[] = [], oauth = false) => runCli(args(extra), options(oauth));
const envelope = (cursor: number) => ({
  schemaVersion: 1,
  type: "result",
  command: "mailboxes.events",
  data: { cursor: String(cursor), id: event(cursor).id, event: event(cursor).event },
});
const lines = (stdout: string) =>
  stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

describe("mailbox events origin", () => {
  const apiOnly = (env: Record<string, string>) => ({
    ...options(),
    env: { SAMVA_API_KEY: "sk_test_mailbox", ...env },
  });
  it("requires an override when the API host has no api label", async () => {
    const result = await runCli(args(), apiOnly({ SAMVA_API_URL: "http://localhost:8787" }));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("SAMVA_EVENTS_URL");
  });
  it("rejects URL credentials", async () => {
    const result = await runCli(
      args(),
      apiOnly({
        SAMVA_API_URL: "https://api.samva.dev",
        SAMVA_EVENTS_URL: "wss://secret@example.com",
      }),
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("credentials");
  });
});
describe("mailbox events over a Bun WebSocket", () => {
  for (const oauth of [false, true]) {
    it(`authenticates the handshake with ${oauth ? "OAuth" : "an API key"} headers`, async () => {
      await configure({ frames: [event(1)] });
      const result = await run(
        ["--limit", "1", "--cursor", opaqueCursor, mailbox, otherMailbox],
        oauth,
      );
      expect(result.code, result.stderr).toBe(0);
      const recorded = await state();
      expect(recorded.handshakes).toHaveLength(1);
      const handshake = recorded.handshakes[0]!;
      const url = new URL(handshake.url);
      expect(url.pathname).toBe("/v1/mailboxes/events");
      expect(url.searchParams.get("cursor")).toBe(opaqueCursor);
      expect(url.searchParams.getAll("mailboxId")).toEqual([mailbox, otherMailbox]);
      expect([...url.searchParams.keys()]).toEqual(["cursor", "mailboxId", "mailboxId"]);
      expect(handshake.headers["x-samva-client"]).toMatch(/^cli\//);
      expect(handshake.headers["x-api-key"]).toBe(oauth ? undefined : "sk_test_mailbox");
      expect(handshake.headers.authorization).toBe(oauth ? "Bearer oauth-test-token" : undefined);
      expect(handshake.headers["x-org-slug"]).toBe(oauth ? "acme" : undefined);
      expect(lines(result.stdout)).toEqual([
        { cursor: "1", id: event(1).id, event: event(1).event },
      ]);
      expect(recorded.acks).toEqual([{ kind: "ack", cursor: "1" }]);
      expect(recorded.closes).toEqual([{ code: 1000, reason: "" }]);
    });
  }
  it("acknowledges every 32 events and the last one handled", async () => {
    await configure({
      frames: [
        ...Array.from({ length: 33 }, (_, i) => event(i + 1)),
        { kind: "live", cursor: "34" },
        event(35),
        { kind: "pong" },
        event(37),
      ],
      closeAfterAck: false,
    });
    const result = await run(["--limit", "35"]);
    expect(result.code, result.stderr).toBe(0);
    expect(lines(result.stdout)).toHaveLength(35);
    expect(result.stderr).toBe("Mailbox event stream is live.\n");
    const recorded = await state();
    expect(recorded.acks).toEqual([
      { kind: "ack", cursor: "32" },
      { kind: "ack", cursor: "37" },
    ]);
  });
  it("keeps live and pong frames out of machine output", async () => {
    await configure({
      frames: [{ kind: "live", cursor: "0" }, { kind: "pong" }, event(1)],
    });
    const result = await run(["--limit", "1", "--jsonl"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(lines(result.stdout)).toEqual([envelope(1)]);
  });
  it("streams one result envelope per line with --jsonl", async () => {
    await configure({ frames: [event(1), event(2), event(3)], closeAfterAck: false });
    const result = await run(["--limit", "3", "--jsonl"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(3);
    expect(lines(result.stdout)).toEqual([envelope(1), envelope(2), envelope(3)]);
    expect(result.stderr).toBe("");
  });
  it.each([[[]], [["--limit", "1"]]])(
    "refuses --json before connecting, naming --jsonl (%j)",
    async (extra) => {
      await configure({ frames: [event(1)] });
      const result = await run([...extra, "--json"]);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      const error = JSON.parse(result.stderr);
      expect(error).toMatchObject({ type: "error", reason: "events_requires_jsonl" });
      expect(error.message).toContain("--jsonl");
      expect((await state()).handshakes).toHaveLength(0);
    },
  );
  it("prints no events with --quiet but still acknowledges and exits cleanly", async () => {
    await configure({ frames: [event(1), event(2)], closeAfterAck: false });
    const result = await run(["--limit", "2", "--quiet"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect((await state()).acks).toEqual([{ kind: "ack", cursor: "2" }]);
  });
  it("rejects invalid frames and reports the last cursor", async () => {
    await configure({
      frames: [event(7), { kind: "live", cursor: "8" }, { kind: "invalid", cursor: "9" }],
    });
    const result = await run();
    expect(result.code).toBe(1);
    expect(lines(result.stdout)).toHaveLength(1);
    expect(result.stderr).toContain("Invalid mailbox event frame");
    expect(result.stderr).toContain("Last cursor: 7");
  });
  it.each([
    [4400, 2],
    [4401, 4],
    [4403, 4],
    [4404, 1],
    [4408, 1],
    [1011, 1],
  ])("maps close %s to exit %s", async (code, exit) => {
    await configure({ frames: [event(9)], close: code });
    const result = await run(["--no-reconnect"]);
    expect(result.code, result.stderr).toBe(exit);
    expect(result.stderr).toContain(`(${code})`);
    expect(result.stderr).toContain("Last cursor: 9");
    if (code === 4408) expect(result.stderr).toContain("--cursor 9");
  });
  it("explains a replay cursor that expired while waiting for acknowledgements", async () => {
    await configure({ frames: [event(9)], close: MailboxEventStreamCloseCode.cursorExpired });
    const result = await run(["--cursor", "5"]);
    expect(result.code, result.stderr).toBe(1);
    expect(lines(result.stdout)).toEqual([{ cursor: "9", id: event(9).id, event: event(9).event }]);
    expect(result.stderr).toContain(`(${MailboxEventStreamCloseCode.cursorExpired})`);
    expect(result.stderr).toContain("CursorExpiredError");
    expect(result.stderr).toContain("Events after the cursor");
    expect(result.stderr).toContain(
      "Read current state from the API and reconnect without --cursor",
    );
    expect(result.stderr).toContain("Last cursor: 9");
  });
  it.each([
    [401, "UnauthorizedError", 4],
    [403, "ForbiddenError", 4],
    [404, "ResourceNotFoundError", 1],
    [405, "MethodNotAllowedError", 1],
    [410, "CursorExpiredError", 1],
    [422, "ValidationError", 1],
    [429, "RateLimitedError", 1],
    [503, "ServiceUnavailableError", 1],
  ])("maps HTTP refusal %s (%s) to exit %s", async (status, tag, exit) => {
    await configure({ refusal: status });
    const result = await run(["--cursor", "19", "--no-reconnect"]);
    expect(result.code, result.stderr).toBe(exit);
    expect(result.stderr).toContain(`(${status})`);
    expect(result.stderr).toContain(tag);
    expect(result.stderr).toContain("Last cursor: 19");
    expect(result.stdout).toBe("");
    if (status === 410) expect(result.stderr).toContain("without --cursor");
    expect((await state()).handshakes).toHaveLength(2);
  });
  it("reports a host that keeps answering 426 as a disconnect", async () => {
    await configure({ refusal: 426 });
    const result = await run(["--cursor", "19", "--no-reconnect"]);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain("disconnected");
    expect(result.stderr).toContain("Last cursor: 19");
  });
  it("carries the refusal's tag, status, public fields, and next step in the JSONL error envelope", async () => {
    await configure({
      refusal: 422,
      refusalBody: {
        _tag: "ValidationError",
        message: "The cursor is not one this stream issued.",
        fields: { cursor: ["Expected a cursor from an event frame"] },
      },
    });
    const result = await run(["--cursor", "not-a-cursor", "--jsonl"]);
    expect(result.code, result.stderr).toBe(1);
    const errorEnvelope = JSON.parse(result.stderr);
    expect(errorEnvelope).toMatchObject({
      type: "error",
      reason: "ValidationError",
      status: 422,
      details: { fields: { cursor: ["Expected a cursor from an event frame"] } },
      message: "Mailbox event stream refused (422): The cursor is not one this stream issued.",
    });
    expect(errorEnvelope.next).toContain("Fix the listed fields");
  });
  it("names the retry delay from a rate-limited refusal", async () => {
    await configure({
      refusal: 429,
      refusalBody: { _tag: "RateLimitedError", message: "Too many streams", retryAfterSeconds: 7 },
    });
    const result = await run(["--jsonl", "--no-reconnect"]);
    expect(result.code, result.stderr).toBe(1);
    const errorEnvelope = JSON.parse(result.stderr);
    expect(errorEnvelope).toMatchObject({
      reason: "RateLimitedError",
      status: 429,
      details: { retryAfterSeconds: 7 },
    });
    expect(errorEnvelope.next).toContain("7 seconds");
  });
  it.each(["--jsonl"])(
    "keeps stderr one JSON diagnostic with the last cursor in details (%s)",
    async (flag) => {
      await configure({
        refusal: 410,
        refusalBody: { _tag: "CursorExpiredError", message: "Gone" },
      });
      const result = await run(["--cursor", "19", flag]);
      expect(result.code, result.stderr).toBe(1);
      expect(result.stderr).not.toContain("Last cursor");
      expect(JSON.parse(result.stderr)).toMatchObject({
        reason: "CursorExpiredError",
        details: { lastCursor: "19" },
      });
    },
  );
  it("exits 4 with the API tag for an unauthorized refusal in JSON mode", async () => {
    await configure({ refusal: 401 });
    const result = await run(["--jsonl"]);
    expect(result.code, result.stderr).toBe(4);
    expect(JSON.parse(result.stderr)).toMatchObject({ reason: "UnauthorizedError", status: 401 });
  });
  it.each([
    [400, 2],
    [404, 1],
    [410, 1],
  ])("falls back to status guidance for an undecodable %s refusal", async (status, exit) => {
    await configure({ refusal: status, refusalBody: "Refused" });
    const result = await run(["--cursor", "19"]);
    expect(result.code, result.stderr).toBe(exit);
    expect(result.stderr).toContain(`Mailbox event stream refused (${status})`);
    if (status === 410) expect(result.stderr).toContain("without --cursor");
  });
  it("exits non-zero and names the last cursor when --no-reconnect meets a dropped connection", async () => {
    await configure({ frames: [event(9)], terminate: true });
    const result = await run(["--jsonl", "--no-reconnect"]);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain("(1006)");
    expect(result.stderr).toContain("Reconnect with --cursor 9");
    expect((await state()).handshakes).toHaveLength(1);
  });
  it("reconnects from the last handled cursor after a dropped connection", async () => {
    await configure({ frames: [event(9)], terminate: 1, reconnectFrames: [event(10)] });
    const result = await run(["--jsonl", "--limit", "2"]);
    expect(result.code, result.stderr).toBe(0);
    expect(lines(result.stdout)).toEqual([envelope(9), envelope(10)]);
    const recorded = await state();
    expect(recorded.handshakes).toHaveLength(2);
    expect(new URL(recorded.handshakes[1]!.url).searchParams.get("cursor")).toBe("9");
    expect(lines(result.stderr)).toEqual([
      {
        schemaVersion: 1,
        type: "warning",
        command: "mailboxes.events",
        reason: "mailbox_events_reconnecting",
        message: "Mailbox event stream dropped (closed with 1006). Reconnecting from cursor 9.",
        details: {
          errorTag: "StreamDisconnectedError",
          closeCode: 1006,
          cursor: "9",
          attempt: 1,
          retryInMillis: expect.any(Number),
        },
      },
    ]);
  });
  it("prints one stderr line per reconnect in human mode and none with --quiet", async () => {
    await configure({ frames: [event(9)], terminate: 1, reconnectFrames: [event(10)] });
    const human = await run(["--limit", "2"]);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stderr).toMatch(
      /Mailbox event stream dropped \(closed with 1006\)\. Reconnecting from cursor 9 in [\d.]+s \(attempt 1\)\.\n/,
    );
    await configure({ frames: [event(9)], terminate: 1, reconnectFrames: [event(10)] });
    const quiet = await run(["--limit", "2", "--quiet"]);
    expect(quiet.code, quiet.stderr).toBe(0);
    expect(quiet.stderr).toBe("");
  });
  it("still ends on a close the stream cannot recover from after a reconnect", async () => {
    await configure({
      frames: [event(9)],
      terminate: 1,
      reconnectFrames: [event(10)],
      reconnectClose: MailboxEventStreamCloseCode.unauthorized,
    });
    const result = await run(["--jsonl"]);
    expect(result.code, result.stderr).toBe(4);
    const diagnostics = lines(result.stderr);
    expect(diagnostics.map((line) => line.type)).toEqual(["warning", "error"]);
  });
  it("exits cleanly when the server closes normally", async () => {
    await configure({ frames: [event(1)], close: 1000 });
    const result = await run();
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(lines(result.stdout)).toHaveLength(1);
  });
  it("rejects nonpositive limits before connecting", async () => {
    await configure({});
    const result = await run(["--limit", "0"]);
    expect(result.code).toBe(2);
    expect((await state()).handshakes).toHaveLength(0);
  });
  it("SIGINT closes with 1000 and exits zero", async () => {
    await configure({ frames: [event(1), { kind: "live", cursor: "1" }] });
    const child = spawnCli(args(), options());
    let stdout = "";
    let stderr = "";
    const ready = new Promise<void>((resolve) =>
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
        if (stderr.includes("stream is live")) resolve();
      }),
    );
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
    await ready;
    child.kill("SIGINT");
    expect(await closed, stderr).toBe(0);
    expect(lines(stdout)).toHaveLength(1);
    expect(stderr).not.toContain("Last cursor");
    expect((await state()).closes[0]?.code).toBe(1000);
  });
});
