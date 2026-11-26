import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type AddressInfo, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "@effect/vitest";
import { matchesLogFilters } from "@samva/contracts/developer/log-stream";
import { LogCursor } from "@samva/contracts/developer/logs-group";
import { Schema } from "effect";

import { formatLogLine } from "../src/commands/logs";
import { runCli, spawnCli } from "./support/run-cli";

const timestamp = "2026-11-25T10:38:13.790Z";
const line = {
  id: "mevt_1234567890abcdef",
  messageId: "msg_1234567890abcdef",
  timestamp,
  cursor: Schema.encodeSync(LogCursor)({
    recordedTxid: "100",
    id: "mevt_1234567890abcdef",
    at: "2026-11-25T10:38:13.790000Z",
  }),
  event: "delivered",
  channel: "email",
  direction: "outbound",
  origin: "direct",
  from: null,
  recipient: "a@b.com",
  subject: "Subject with spaces",
  submission: null,
  reason: null,
  requestId: "req_example",
  errorTag: null,
} as const;
const waiting = {
  ...line,
  id: "mevt_abcdef1234567890",
  event: "waiting",
  reason: "onboarding-review",
  timestamp: "2026-11-25T10:38:13.000Z",
} as const;
const rejected = {
  ...line,
  id: "rej_1234567890abcdef",
  event: "rejected",
  messageId: null,
  subject: null,
  recipient: null,
  errorTag: "ValidationError",
} as const;

const fixture = async (handler: RequestListener) => {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const configHome = await mkdtemp(join(tmpdir(), "samva-cli-logs-"));
  onTestFinished(async () => {
    server.close();
    server.closeAllConnections();
    await rm(configHome, { recursive: true, force: true });
  });
  return {
    configHome,
    env: {
      SAMVA_API_KEY: "samva_test",
      SAMVA_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    },
  };
};

describe("samva logs", () => {
  it("aligns terminal columns and respects the color choice", () => {
    expect(formatLogLine(line, true, true, true)).toBe(
      '2026-11-25T10:38:13.790Z  \u001b[32mdelivered   \u001b[0m  email     msg_1234567890abcdef  → a@b.com  "Subject with spaces"',
    );
    expect(formatLogLine(line, true, false, true)).toBe(
      '2026-11-25T10:38:13.790Z  delivered     email     msg_1234567890abcdef  → a@b.com  "Subject with spaces"',
    );
    expect(formatLogLine(line, true, false)).toMatch(
      /^2026-11-(24|25|26) \d{2}:\d{2}:13\.790 [+-]\d{2}:\d{2}  delivered/u,
    );
    expect(formatLogLine(rejected, false, false)).toBe(
      "2026-11-25T10:38:13.790Z\trejected\temail\trej_1234567890abcdef\tValidationError\treq_example\t\t",
    );
  });

  it("prints piped lines oldest first and raw JSONL with per-line cursors", async () => {
    const requests: URL[] = [];
    const options = await fixture((req, res) => {
      requests.push(new URL(req.url ?? "/", "http://localhost"));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ items: [line, waiting], nextCursor: null }));
    });
    const human = await runCli(["logs"], options);
    expect(human).toEqual({
      code: 0,
      stderr: "",
      stdout:
        '2026-11-25T10:38:13.000Z\twaiting\temail\tmsg_1234567890abcdef\tonboarding-review\treq_example\t→ a@b.com\t"Subject with spaces"\n2026-11-25T10:38:13.790Z\tdelivered\temail\tmsg_1234567890abcdef\t\treq_example\t→ a@b.com\t"Subject with spaces"\n',
    });
    const jsonl = await runCli(["logs", "event:waiting,delivered", "-r", "--jsonl"], options);
    expect(jsonl.code).toBe(0);
    expect(jsonl.stderr).toBe("");
    expect(
      jsonl.stdout
        .trimEnd()
        .split("\n")
        .map((record) => JSON.parse(record)),
    ).toEqual([line, waiting]);
    expect(
      requests.map(({ pathname, searchParams }) => [
        pathname,
        searchParams.get("order"),
        searchParams.get("event"),
      ]),
    ).toEqual([
      ["/v1/logs", "desc", null],
      ["/v1/logs", "desc", "waiting,delivered"],
    ]);
  });

  it("walks after cursors and returns an empty array with exit 0 when there are no matches", async () => {
    const requests: URL[] = [];
    const options = await fixture((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      requests.push(url);
      const next = url.searchParams.has("after");
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          next ? { items: [], nextCursor: null } : { items: [line], nextCursor: line.cursor },
        ),
      );
    });
    const all = await runCli(["logs", "--all", "--json"], options);
    expect(all.code, all.stderr).toBe(0);
    expect(JSON.parse(all.stdout)).toEqual([line]);
    expect(requests.map(({ searchParams }) => searchParams.get("after"))).toEqual([
      null,
      line.cursor,
    ]);

    const empty = await runCli(["logs", "--after", line.cursor, "--json"], options);
    expect(empty).toEqual({ code: 0, stderr: "", stdout: "[]\n" });
    expect(requests.map(({ searchParams }) => searchParams.get("orderBy"))).toEqual([
      "timestamp",
      "timestamp",
      "recorded",
    ]);
  });

  it("keeps late live events after an ingestion checkpoint", () => {
    const after = Schema.decodeUnknownSync(LogCursor)(line.cursor);
    const at = "2026-11-25T10:00:00.000000Z";
    const encode = Schema.encodeSync(LogCursor);
    const liveEvent = (recordedTxid: string, id: string) => ({
      cursor: "42",
      match: { senderAddresses: [], mailboxIds: [], credential: "key" },
      line: { ...line, cursor: encode({ at, id, recordedTxid }), timestamp: at },
    });

    expect(matchesLogFilters({ after }, liveEvent("101", "mevt_0000000000000000"))).toBe(true);
    expect(matchesLogFilters({ after }, liveEvent("100", "mevt_abcdef1234567890"))).toBe(true);
    expect(matchesLogFilters({ after }, liveEvent("100", after.id))).toBe(false);
    expect(matchesLogFilters({ after }, liveEvent("99", "mevt_abcdef1234567890"))).toBe(false);
  });

  it("prints the response request ID on a typed API error", async () => {
    const options = await fixture((_req, res) => {
      res.writeHead(404, {
        "Content-Type": "application/json",
        "x-samva-request-id": "req_lookup",
      });
      res.end(
        JSON.stringify({
          _tag: "ResourceNotFoundError",
          resource: "Log entry",
          id: "req_example",
          message: "Log entry not found",
        }),
      );
    });
    const result = await runCli(["logs", "show", "req_example"], options);
    expect(result.code).toBeGreaterThan(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("request: req_lookup");
  });

  it("displays a request ID when the API returns an undeclared status", async () => {
    const options = await fixture((_req, res) => {
      res.writeHead(503, { "x-samva-request-id": "req_unavailable" });
      res.end("Service unavailable");
    });
    const result = await runCli(["logs"], options);
    expect(result.code).toBeGreaterThan(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("request: req_unavailable");
  });

  it("exits 130 on Ctrl+C while awaiting a page", async () => {
    let notify: (() => void) | undefined;
    const requested = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const options = await fixture(() => {
      notify?.();
    });
    const child = spawnCli(["logs"], options);
    const closed = once(child, "close");
    await Promise.race([
      requested,
      closed.then(() => {
        throw new Error("The CLI exited before requesting logs");
      }),
    ]);
    child.kill("SIGINT");
    const [code] = await closed;
    expect(code).toBe(130);
  });
});
