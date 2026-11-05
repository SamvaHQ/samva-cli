import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest";

import { runCli } from "./support/run-cli";

const now = "2026-11-02T00:00:00.000Z";
const PROJECT_ID = "tproj_2eqcmea000000000";
const EMAIL_ID = "tmpl_2eqcmea000000000";
const SMS_ID = "tmpl_6sms000000000000";
const WHATSAPP_ID = "tmpl_5whatsapp00000000";

const summary = (id: string, slug: string, channel: string) => ({
  id,
  slug,
  name: slug,
  channel,
  projectId: PROJECT_ID,
  namespaceId: null,
  shared: false,
  entryPath: `templates/${slug}.tsx`,
  status: "draft",
  isActive: true,
  publishedAt: null,
  brand: null,
  fromDefault: null,
  usageCount: 0,
  lastUsedAt: null,
  createdAt: now,
  updatedAt: now,
});

const whatsappTemplate = {
  ...summary(WHATSAPP_ID, "order-update", "whatsapp"),
  familyId: null,
  description: null,
  category: null,
  email: null,
  sms: null,
  whatsapp: { name: "order_update", language: "en_US", category: "utility", components: [] },
  replyToDefault: null,
  trackingDefault: null,
  publicationId: null,
  inputContractId: null,
  inputSchema: null,
};

let apiUrl = "";
let home = "";
const paths: string[] = [];
let mode: "mixed" | "paged" | "unreadable" | "unavailable" | "transient" = "mixed";
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  paths.push(url.pathname + url.search);
  const send = (status: number, value: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  if (mode === "transient" && paths.length === 1) {
    return send(500, { _tag: "InternalError", message: "Try again" });
  }
  if (mode === "unavailable") {
    return send(403, { _tag: "ForbiddenError", message: "templates are forbidden" });
  }
  if (request.method === "GET" && url.pathname === "/v1/templates") {
    if (mode === "unreadable")
      return send(200, { items: [{ channel: "pigeon" }], nextCursor: null });
    if (mode === "paged" && url.searchParams.get("cursor") === null) {
      return send(200, {
        items: [summary(WHATSAPP_ID, "order-update", "whatsapp")],
        nextCursor: "page_2",
      });
    }
    if (mode === "paged") {
      return send(200, { items: [summary(EMAIL_ID, "welcome", "email")], nextCursor: null });
    }
    return send(200, {
      items: [
        summary(EMAIL_ID, "welcome", "email"),
        summary(WHATSAPP_ID, "order-update", "whatsapp"),
        summary(SMS_ID, "verification", "sms"),
      ],
      nextCursor: null,
    });
  }
  if (request.method === "GET" && url.pathname === `/v1/templates/${WHATSAPP_ID}`) {
    if (mode === "unreadable") return send(200, { channel: "pigeon" });
    return send(200, whatsappTemplate);
  }
  send(404, {
    _tag: "ResourceNotFoundError",
    resource: "Route",
    id: url.pathname,
    message: "no route",
  });
});

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "samva-template-channels-"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  await rm(home, { recursive: true, force: true });
});

beforeEach(() => {
  paths.length = 0;
  mode = "mixed";
});

const run = (args: ReadonlyArray<string>) =>
  runCli(args, {
    configHome: home,
    env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "samva_sk_test_channels" },
  });

describe("templates across channels", () => {
  it("lists an email template beside a WhatsApp one", async () => {
    const result = await run(["templates", "list", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.items.map((item: { id: string }) => item.id)).toEqual([
      EMAIL_ID,
      WHATSAPP_ID,
      SMS_ID,
    ]);
  });

  it("streams a mixed-channel list as one resource per line", async () => {
    const result = await run(["templates", "list", "--jsonl"]);
    expect(result.code, result.stderr).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).data.channel)).toEqual([
      "email",
      "whatsapp",
      "sms",
    ]);
  });

  it("gets a WhatsApp template with its compiled content", async () => {
    const result = await run(["templates", "get", WHATSAPP_ID, "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout).data;
    expect(data).toMatchObject({
      id: WHATSAPP_ID,
      channel: "whatsapp",
      whatsapp: { name: "order_update", language: "en_US", category: "utility" },
      email: null,
    });
    expect(paths).toEqual([`/v1/templates/${WHATSAPP_ID}`]);
  });

  it("reads the same list in human mode", async () => {
    const result = await run(["templates", "list"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(EMAIL_ID);
    expect(result.stdout).toContain(WHATSAPP_ID);
    expect(result.stdout).toContain(SMS_ID);
  });

  it("sends each list filter it was given and omits the ones it was not", async () => {
    const filtered = await run([
      "templates",
      "list",
      "--limit",
      "5",
      "--namespace",
      "ns_1234567890123456",
      "--shared",
      "true",
      "--json",
    ]);
    expect(filtered.code, filtered.stderr).toBe(0);
    expect(paths).toHaveLength(1);
    const query = new URL(paths[0]!, apiUrl).searchParams;
    expect(Object.fromEntries(query)).toEqual({
      limit: "5",
      namespaceId: "ns_1234567890123456",
      shared: "true",
    });
  });

  it("follows nextCursor across pages under --all", async () => {
    mode = "paged";
    const result = await run(["templates", "list", "--all", "--jsonl"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toHaveLength(2);
    expect(paths).toEqual(["/v1/templates", "/v1/templates?cursor=page_2"]);
  });
});

describe("templates read failures", () => {
  it("retries a transient API failure through the SDK", async () => {
    mode = "transient";
    const result = await run(["templates", "list", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(paths).toEqual(["/v1/templates", "/v1/templates"]);
    expect(JSON.parse(result.stdout).data.items).toHaveLength(3);
  });

  it("reports an unreadable page without an API error reason", async () => {
    mode = "unreadable";
    const result = await run(["templates", "list", "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      reason: "operational_failure",
      message: expect.stringContaining("Could not list templates"),
    });
  });

  it("keeps an API failure's reason and status", async () => {
    mode = "unavailable";
    const result = await run(["templates", "list", "--json"]);
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stderr)).toMatchObject({
      reason: "ForbiddenError",
      status: 403,
    });
  });
});

describe("templates authentication failures", () => {
  it("keeps the missing-credentials code and exit status", async () => {
    const result = await runCli(["templates", "list", "--json"], {
      configHome: home,
      env: {},
    });
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stderr)).toMatchObject({
      reason: "missing_credentials",
      type: "error",
    });
  });
});
