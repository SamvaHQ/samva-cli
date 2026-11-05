import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest";

import { runCli } from "./support/run-cli";

let server: Server;
let apiUrl: string;
let home: string;
let requests: Array<{ method: string; path: string; body: unknown }> = [];

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "samva-strict-json-"));
  server = createServer((request, response) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "wep_1234567890123456",
          name: "delivery",
          url: "https://example.com/hook",
          eventTypes: ["message.delivered"],
          channels: null,
          mailboxIds: null,
          namespaceId: null,
          status: "active",
          hasCustomHeaders: false,
          failureStartedAt: null,
          lastSucceededAt: null,
          createdAt: "2026-11-03T00:00:00.000Z",
          updatedAt: "2026-11-03T00:00:00.000Z",
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test API port");
  apiUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(home, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
});

const cli = (args: ReadonlyArray<string>) =>
  runCli(args, {
    configHome: home,
    env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "samva_sk_test_strict_json" },
  });

describe("CLI JSON request validation", () => {
  const definition = {
    trigger: { type: "contact.created" },
    rootNodeId: "done",
    nodes: { done: { type: "exit", config: {}, next: [] } },
  };

  it("rejects unknown journey definition fields before any HTTP request", async () => {
    const result = await cli([
      "journeys",
      "create",
      "--name",
      "Welcome",
      "--definition",
      JSON.stringify({ ...definition, typo: true }),
      "--json",
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("typo");
    expect(requests).toEqual([]);
  });

  it("accepts named journey nodes in their open record", async () => {
    const result = await cli([
      "journeys",
      "create",
      "--name",
      "Welcome",
      "--definition",
      JSON.stringify(definition),
      "--dry-run",
      "--json",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.request.definition).toEqual(definition);
    expect(requests).toEqual([]);
  });

  it.each([
    ['{"events":["message.delivered"]}', ["events"]],
    ['{"events":[],"typo":true}', ["events", "typo"]],
    ['{"__proto__":{"polluted":true}}', ["__proto__"]],
  ])("rejects webhook update %s before any HTTP request", async (input, fields) => {
    const result = await cli([
      "webhooks",
      "update",
      "wep_1234567890123456",
      "--data",
      input,
      "--json",
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    for (const field of fields) expect(result.stderr).toContain(field);
    expect(requests).toEqual([]);
  });

  it("sends valid webhook fields to the API", async () => {
    const result = await cli([
      "webhooks",
      "update",
      "wep_1234567890123456",
      "--data",
      '{"eventTypes":["message.delivered"]}',
      "--json",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(requests).toEqual([
      {
        method: "PATCH",
        path: "/v1/webhooks/wep_1234567890123456",
        body: { eventTypes: ["message.delivered"] },
      },
    ]);
  });

  it.each([
    [
      "webhooks",
      '{"name":"delivery","url":"https://example.com/hook","eventTypes":["message.delivered"],"events":[]}',
      "events",
    ],
    ["templates", '{"name":"Welcome","naem":"typo"}', "naem"],
  ])(
    "rejects unknown %s creation fields before any HTTP request",
    async (command, input, field) => {
      const result = await cli([command, "create", "--data", input, "--json"]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(field);
      expect(requests).toEqual([]);
    },
  );

  it("preserves arbitrary mailbox metadata keys", async () => {
    const result = await cli([
      "mailboxes",
      "update",
      "mbx_1234567890123456",
      "--data",
      '{"metadata":{"customer_specific_key":"value"}}',
      "--dry-run",
      "--json",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.request).toEqual({
      metadata: { customer_specific_key: "value" },
    });
    expect(requests).toEqual([]);
  });

  it("preserves arbitrary webhook test data", async () => {
    const result = await cli([
      "webhooks",
      "test",
      "wep_1234567890123456",
      "--data",
      '{"customer_specific_key":{"nested":true}}',
      "--dry-run",
      "--json",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.request).toEqual({
      data: { customer_specific_key: { nested: true } },
    });
    expect(requests).toEqual([]);
  });

  it("accepts the documented webhook eventTypes field", async () => {
    const result = await cli([
      "webhooks",
      "update",
      "wep_1234567890123456",
      "--data",
      '{"eventTypes":["message.delivered"]}',
      "--dry-run",
      "--json",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.request).toEqual({ eventTypes: ["message.delivered"] });
    expect(requests).toEqual([]);
  });

  it.each([
    ['{"naem":"Welcome"}', "naem"],
    ['{"trackingDefault":{"opens":true,"typo":true}}', "typo"],
    ['{"__proto__":{"polluted":true}}', "__proto__"],
  ])("rejects template update %s before any HTTP request", async (input, field) => {
    const result = await cli([
      "templates",
      "update",
      "tmpl_1234567890123456",
      "--data",
      input,
      "--json",
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(field);
    expect(requests).toEqual([]);
  });

  it("accepts template updates with the shared flag merged into the request", async () => {
    const result = await cli([
      "templates",
      "update",
      "tmpl_1234567890123456",
      "--data",
      '{"name":"Welcome"}',
      "--shared",
      "true",
      "--dry-run",
      "--json",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.request).toEqual({
      data: { name: "Welcome", shared: true },
    });
    expect(requests).toEqual([]);
  });
});
