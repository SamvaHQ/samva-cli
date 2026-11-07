import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest";

import { runCli } from "./support/run-cli";

const namespaceId = "ns_1234567890123456";
const sourceId = "ksrc_1234567890123456";
const date = "2026-11-01T00:00:00.000Z";
const source = {
  id: sourceId,
  namespaceId,
  kind: "website",
  name: "Acme",
  url: "https://example.com",
  file: null,
  status: "pending",
  sync: { running: false, syncedAt: null, failure: null, nextSyncAt: null },
  documentCount: 0,
  chunkCount: 0,
  createdAt: date,
  updatedAt: date,
};
const requests: Array<{ method: string; path: string; body: unknown }> = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };
let configHome = "";
let apiUrl = "";
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  requests.push({
    method: request.method!,
    path: request.url!,
    body: body ? JSON.parse(body) : undefined,
  });
  response.writeHead(reply.status, { "content-type": "application/json" });
  response.end(JSON.stringify(reply.body));
});
beforeAll(async () => {
  configHome = await mkdtemp(join(tmpdir(), "samva-namespace-reach-"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await rm(configHome, { recursive: true, force: true });
});
beforeEach(() => {
  requests.length = 0;
});
const run = (args: ReadonlyArray<string>, body: unknown, status = 200) => {
  reply = { status, body };
  return runCli(args, {
    configHome,
    env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "sk_test_namespace_reach" },
  });
};

describe("namespace reach at the CLI request boundary", () => {
  it.each([
    ["scheduled-messages", "list", { items: [], nextCursor: null }, "/v1/messages/scheduled"],
    ["conversations", "list", { items: [], nextCursor: null }, "/v1/conversations"],
    ["analytics", "stats", { volumeHistory: [] }, "/v1/analytics/stats"],
    [
      "analytics",
      "delivery-metrics",
      { deliveredRate: 0, failedRate: 0, pendingRate: 0, avgDeliveryTimeMs: 0 },
      "/v1/analytics/delivery-metrics",
    ],
    ["knowledge", "list", { items: [] }, "/v1/knowledge/sources"],
  ])("%s %s forwards --namespace as a query filter", async (command, action, body, path) => {
    const result = await run([command, action, "--namespace", namespaceId, "--json"], body);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).command).toBe(`${command}.${action}`);
    const request = requests[0]!;
    expect(request.method).toBe("GET");
    const url = new URL(request.path, apiUrl);
    expect(url.pathname).toBe(path);
    expect(url.searchParams.get("namespaceId")).toBe(namespaceId);
  });

  it.each([
    ["conversations", ["create", "--channel", "email"]],
    [
      "scheduled-messages",
      [
        "create",
        "--to",
        "ada@example.com",
        "--subject",
        "Hello",
        "--html",
        "<p>Hello</p>",
        "--at",
        "2027-01-01T09:00:00Z",
      ],
    ],
    ["knowledge", ["add-website", "--url", "https://example.com"]],
    ["knowledge", ["add-file", "--media-id", "media_1234567890123456"]],
  ])("%s dry-run keeps the requested namespace without network traffic", async (command, args) => {
    const result = await run(
      [command, ...args, "--namespace", namespaceId, "--dry-run", "--json"],
      {},
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.request.namespaceId).toBe(namespaceId);
    expect(requests).toEqual([]);
  });

  it("creates a schedule with the namespace in the actual request body", async () => {
    const schedule = {
      id: "sched_1234567890123456",
      namespaceId,
      status: "pending",
      scheduledFor: "2027-01-01T09:00:00.000Z",
      timezone: "UTC",
      send: {
        channel: "email",
        to: [{ email: "ada@example.com" }],
        email: { subject: "Hello", html: "<p>Hello</p>" },
      },
      messageId: null,
      idempotencyKey: null,
      referenceId: null,
      failureReason: null,
      attempts: 0,
      createdBy: null,
      actorEmail: "owner@example.com",
      memberRole: "owner",
      createdAt: date,
      updatedAt: date,
    };
    const result = await run(
      [
        "scheduled-messages",
        "create",
        "--to",
        "ada@example.com",
        "--subject",
        "Hello",
        "--html",
        "<p>Hello</p>",
        "--at",
        schedule.scheduledFor,
        "--namespace",
        namespaceId,
        "--json",
      ],
      schedule,
      201,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/messages/scheduled",
      body: { namespaceId },
    });
    expect(JSON.parse(result.stdout).data.namespaceId).toBe(namespaceId);
  });

  it("adds a website in its namespace and retains that scope in output", async () => {
    const result = await run(
      [
        "knowledge",
        "add-website",
        "--url",
        "https://example.com",
        "--namespace",
        namespaceId,
        "--json",
      ],
      source,
      201,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/knowledge/sources/websites",
      body: { namespaceId, url: "https://example.com" },
    });
    expect(JSON.parse(result.stdout).data.namespaceId).toBe(namespaceId);
  });

  it("does not invent a namespace when omitted", async () => {
    const result = await run(
      ["conversations", "create", "--channel", "email", "--dry-run", "--json"],
      {},
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.request).not.toHaveProperty("namespaceId");
  });

  it("preserves a scoped-key refusal without retrying or broadening the query", async () => {
    const result = await run(
      ["analytics", "stats", "--namespace", namespaceId, "--json"],
      { _tag: "ForbiddenError", message: "Namespace does not match the key" },
      403,
    );
    expect(result.code).toBe(4);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(result.stderr).reason).toBe("ForbiddenError");
  });

  it("refuses malformed namespace flags before a request", async () => {
    const result = await run(["knowledge", "list", "--namespace", "not-a-namespace", "--json"], {
      items: [],
    });
    expect(result.code).toBe(2);
    expect(requests).toEqual([]);
  });
});
