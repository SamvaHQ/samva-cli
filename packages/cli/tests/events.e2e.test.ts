import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { runCli } from "./support/run-cli";

const id = "contact_7q2xk9mvt4znw8rh";
const event = {
  id: "cevt_7q2xk9mvt4znw8rh",
  contactId: id,
  name: "trial.started",
  source: "api",
  properties: { plan: "starter" },
  occurredAt: "2026-10-13T00:00:00.000Z",
  recordedAt: "2026-10-13T00:00:01.000Z",
};
const payload = {
  contact: { email: "ada@example.com" },
  name: event.name,
  properties: event.properties,
  idempotencyKey: "trial-42",
};
let configHome: string;
let apiUrl: string;
let close: () => Promise<void>;
let requests: Array<{ url: URL; body: unknown; key: unknown }>;
let failSecond: boolean;
beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), "samva-cli-events-"));
  requests = [];
  failSecond = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let source = "";
    for await (const chunk of req) source += chunk;
    requests.push({ url, body: source ? JSON.parse(source) : null, key: req.headers["x-api-key"] });
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/v1/events") return reply(200, event);
    if (url.pathname !== `/v1/contacts/${id}/events`) return reply(404, {});
    const second = url.searchParams.get("cursor") === "next-page";
    if (second && failSecond)
      return reply(403, { _tag: "ForbiddenError", message: "Contacts read permission required" });
    return reply(200, {
      items: [{ ...event, name: second ? "trial.ended" : event.name }],
      nextCursor: second ? null : "next-page",
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("API did not bind");
  apiUrl = `http://127.0.0.1:${address.port}`;
  close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});
afterEach(async () => {
  await close();
  await rm(configHome, { recursive: true, force: true });
});
const cli = (args: string[], stdin?: string) =>
  runCli(args, {
    configHome,
    stdin,
    env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "samva_sk_test_events" },
  });

describe("contact events CLI HTTP boundary", () => {
  it.each(["inline", "file", "stdin"])(
    "records %s JSON and returns every event field",
    async (mode) => {
      const file = join(configHome, "event.json");
      await writeFile(file, JSON.stringify(payload));
      const result = await cli(
        [
          "events",
          "send",
          "--data",
          mode === "inline" ? JSON.stringify(payload) : mode === "file" ? `@${file}` : "-",
          "--json",
        ],
        mode === "stdin" ? JSON.stringify(payload) : undefined,
      );
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({ command: "events.send", data: event });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ body: payload, key: "samva_sk_test_events" });
    },
  );
  it("validates dry runs without credentials or requests", async () => {
    const result = await runCli(
      ["events", "send", "--data", JSON.stringify(payload), "--dry-run", "--json"],
      { configHome },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data).toEqual({
      dryRun: true,
      action: "events.send",
      request: payload,
    });
    expect(requests).toEqual([]);
  });
  it.each([
    "{",
    JSON.stringify({ ...payload, contact: {} }),
    JSON.stringify({ ...payload, contact: { id, email: "ada@example.com" } }),
    JSON.stringify({ ...payload, contact: { email: "ada@example.com", externalId: null } }),
    JSON.stringify({ ...payload, unexpected: true }),
  ])("refuses invalid data before requesting: %s", async (data) => {
    const result = await cli(["events", "send", "--data", data, "--json"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "error" });
    expect(requests).toEqual([]);
  });
  it("prints all receipt facts in human mode", async () => {
    const result = await cli(["events", "send", "--data", JSON.stringify(payload)]);
    expect(result.code).toBe(0);
    for (const value of [event.id, id, event.name, event.source, JSON.stringify(event.properties)])
      expect(result.stdout).toContain(value);
  });
  it("forwards limit and cursor and returns one bounded page", async () => {
    const result = await cli([
      "contacts",
      "events",
      id,
      "--limit",
      "3",
      "--cursor",
      "resume-here",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data).toEqual({ items: [event], nextCursor: "next-page" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.searchParams.get("limit")).toBe("3");
    expect(requests[0]?.url.searchParams.get("cursor")).toBe("resume-here");
  });
  it("streams all pages with JSONL and refuses --all without it", async () => {
    const refused = await cli(["contacts", "events", id, "--all", "--json"]);
    expect(refused.code).toBe(2);
    expect(requests).toEqual([]);
    const result = await cli(["contacts", "events", id, "--all", "--jsonl"]);
    expect(result.code).toBe(0);
    expect(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).data.name),
    ).toEqual(["trial.started", "trial.ended"]);
    expect(requests).toHaveLength(2);
  });
  it("preserves streamed data and fails honestly when a later page is forbidden", async () => {
    failSecond = true;
    const result = await cli(["contacts", "events", id, "--all", "--jsonl"]);
    expect(result.code).toBe(4);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      reason: "ForbiddenError",
      details: { cursor: "next-page" },
    });
  });
});
