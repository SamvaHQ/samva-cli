import { mkdtemp, rm } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { runCli } from "./support/run-cli";

// Never called: puts the spawned entry in this file's import graph for `vitest --changed`.
void (() => import("./whatsapp-status-runner.ts"));

const runner = fileURLToPath(new URL("./whatsapp-status-runner.ts", import.meta.url));
const account = {
  id: "waba_test",
  phoneNumber: "+14155550123",
  displayName: "Acme",
  verificationStatus: "verified",
  credentialStatus: "active",
  isDefault: true,
  isActive: true,
  qualityRating: "green",
  messagingLimit: "TIER_2K",
  currentLimit: 2000,
};
const message = {
  id: "msg_test",
  channel: "whatsapp",
  status: "delivered",
  waitReason: null,
  reviewExpectedAt: null,
  createdAt: "2026-10-24T00:00:00.000Z",
  updatedAt: "2026-10-24T01:00:00.000Z",
};
let body: unknown;
let status: number;
let requests: string[];
let configHome: string;
let origin: string;
let server: ReturnType<typeof createServer>;

beforeEach(async () => {
  body = { items: [account], nextCursor: null };
  status = 200;
  requests = [];
  configHome = await mkdtemp(join(tmpdir(), "samva-whatsapp-status-"));
  server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    expect(req.headers["x-api-key"]).toBe("samva_sk_test_status");
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(configHome, { recursive: true, force: true });
});
const run = (args: string[]) =>
  runCli([runner, "whatsapp", ...args], {
    executable: "bun",
    configHome,
    env: { SAMVA_API_KEY: "samva_sk_test_status", SAMVA_API_URL: origin },
  });

describe("WhatsApp status", () => {
  it("prints each number's status, default marker, tier, and quality", async () => {
    body = {
      items: [
        account,
        { ...account, id: "waba_other", phoneNumber: "+14155550124", isDefault: false },
      ],
      nextCursor: null,
    };
    const result = await run(["status"]);
    expect(result.code).toBe(0);
    for (const value of [
      "+14155550123",
      "+14155550124",
      "Acme",
      "verified",
      "active",
      "Default",
      "yes",
      "no",
      "TIER_2K",
      "2000",
      "green",
    ])
      expect(result.stdout).toContain(value);
    expect(requests).toEqual(["GET /v1/whatsapp/business-accounts?limit=20"]);
  });
  it("succeeds for an empty organization and gives a connection step", async () => {
    body = { items: [], nextCursor: null };
    const result = await run(["status"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No WhatsApp numbers connected");
    expect(result.stdout).toContain("samva whatsapp setup-links create");
    const json = await run(["status", "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      schemaVersion: 1,
      type: "result",
      command: "whatsapp.status",
      data: body,
    });
  });
  it("returns the stable account projection as JSON", async () => {
    body = {
      items: [{ ...account, organizationId: "org_test", webhookUrl: "https://example.test" }],
      nextCursor: null,
    };
    const result = await run(["status", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      type: "result",
      command: "whatsapp.status",
      data: { items: [account], nextCursor: null },
    });
  });
  it("passes the current cursor and prints the continuation", async () => {
    body = {
      items: [account],
      nextCursor: "following",
    };
    const result = await run(["status", "--cursor", "previous", "--limit", "1"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Next cursor");
    expect(result.stdout).toContain("following");
    expect(requests).toEqual(["GET /v1/whatsapp/business-accounts?limit=1&cursor=previous"]);
  });
  it("rejects a malformed account response", async () => {
    body = { items: [{}], nextCursor: null };
    const result = await run(["status", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unreadable WhatsApp account list");
  });
});

describe("WhatsApp message status", () => {
  it("reads the canonical message lifecycle in human and JSON modes", async () => {
    body = message;
    const human = await run(["message", "status", "msg_test"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("delivered");
    const result = await run(["message", "status", "msg_test", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      type: "result",
      command: "whatsapp.message.status",
      data: message,
    });
    expect(requests).toEqual(["GET /v1/messages/msg_test", "GET /v1/messages/msg_test"]);
  });
  it("refuses a message from another channel", async () => {
    body = { ...message, channel: "email" };
    const result = await run(["message", "status", "msg_test", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not a WhatsApp message");
  });
});
