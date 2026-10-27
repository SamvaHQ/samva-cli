import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { runCli } from "./support/run-cli";

const now = "2026-10-11T00:00:00.000Z";
const id = "contact_7q2xk9mvt4znw8rh";
const summary = {
  id,
  namespaceId: null,
  name: "Ada",
  displayName: "Ada Lovelace",
  status: "active",
  email: "ada@example.com",
  channels: ["email"],
  tags: ["customer"],
  lists: [{ id: "cgrp_7q2xk9mvt4znw8rh", name: "Customers", color: "sky" }],
  lastActiveAt: "2026-10-10T18:00:00.000Z",
  createdAt: now,
  customFields: { plan: "pro", score: 42, missing: null },
};
const contact = {
  id,
  namespaceId: null,
  name: "Ada",
  displayName: "Ada Lovelace",
  avatar: "https://example.com/ada.png",
  status: "active",
  statusReason: null,
  externalId: "customer-1",
  identities: [
    {
      id: "cident_7q2xk9mvt4znw8rh",
      type: "email",
      identifier: "ada@example.com",
      verified: false,
      channels: [{ channel: "email", reachability: "unknown", consent: null }],
    },
  ],
  profile: { customFields: { plan: "pro", score: 42 } },
  preferences: null,
  tags: ["customer"],
  metadata: { source: "signup" },
  importProvenance: null,
  createdAt: now,
  updatedAt: now,
};

let configHome: string;
let requests: Array<{ url: URL; apiKey: string | string[] | undefined }>;
let apiUrl: string;
let closeApi: () => Promise<void>;
let forbidden: boolean;
let failSecondPage: false | "forbidden" | "validation" | "transport";

beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), "samva-cli-contacts-"));
  requests = [];
  forbidden = false;
  failSecondPage = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requests.push({ url, apiKey: req.headers["x-api-key"] });
    const reply = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (failSecondPage && url.searchParams.get("cursor") === "next-page") {
      if (failSecondPage === "transport") return req.socket.destroy();
      if (failSecondPage === "validation")
        return reply(422, {
          _tag: "ValidationError",
          message: "Invalid cursor",
          fields: { cursor: ["Invalid pagination cursor"] },
        });
      return reply(403, { _tag: "ForbiddenError", message: "Contacts read permission required" });
    }
    if (forbidden)
      return reply(403, { _tag: "ForbiddenError", message: "Contacts read permission required" });
    if (url.pathname === `/v1/contacts/${id}`) return reply(200, contact);
    if (url.pathname !== "/v1/contacts") return reply(404, {});
    const second = url.searchParams.get("cursor") === "next-page";
    return reply(200, {
      items: [{ ...summary, name: second ? "Grace" : "Ada" }],
      nextCursor: second ? null : "next-page",
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("API did not bind a TCP port");
  apiUrl = `http://127.0.0.1:${address.port}`;
  closeApi = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

afterEach(async () => {
  await closeApi();
  await rm(configHome, { recursive: true, force: true });
});

const cli = (args: ReadonlyArray<string>) =>
  runCli(["contacts", ...args], {
    configHome,
    env: { SAMVA_API_KEY: "samva_sk_test_contacts", SAMVA_API_URL: apiUrl },
  });

describe("contacts CLI HTTP boundary", () => {
  it("forwards filters and projection while returning one bounded page envelope", async () => {
    const result = await cli([
      "list",
      "--search",
      "ada",
      "--status",
      "active",
      "--fields",
      "plan,score",
      "--custom-field",
      "plan",
      "--custom-field-value",
      '"pro"',
      "--limit",
      "25",
      "--cursor",
      "resume",
      "--after",
      now,
      "--before",
      now,
      "--json",
    ]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      type: "result",
      command: "contacts.list",
      data: { items: [summary], nextCursor: "next-page" },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.apiKey).toBe("samva_sk_test_contacts");
    expect(Object.fromEntries(requests[0]!.url.searchParams)).toEqual({
      search: "ada",
      status: "active",
      fields: "plan,score",
      customField: "plan",
      customFieldValue: '"pro"',
      limit: "25",
      cursor: "resume",
      after: now,
      before: now,
    });
  });

  it("streams all pages, preserving filters and one envelope per contact", async () => {
    const result = await cli([
      "list",
      "--all",
      "--jsonl",
      "--fields",
      "plan",
      "--custom-field",
      "score",
      "--custom-field-value",
      "42",
    ]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    const records = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      schemaVersion: 1,
      type: "result",
      command: "contacts.list",
      data: { name: "Ada", customFields: summary.customFields },
    });
    expect(records[1]).toMatchObject({ data: { name: "Grace" } });
    expect(requests.map(({ url }) => url.searchParams.get("cursor"))).toEqual([null, "next-page"]);
    for (const { url } of requests) expect(url.searchParams.get("customFieldValue")).toBe("42");
  });

  it.each([
    ["--custom-field", "plan"],
    ["--custom-field-value", '"pro"'],
    ["--custom-field", "plan", "--custom-field-value", "{}"],
    ["--custom-field", "plan", "--custom-field-value", "[]"],
    ["--custom-field", "plan", "--custom-field-value", "pro"],
    ["--all"],
  ])("rejects invalid input without making a request: %j", async (...flags) => {
    const result = await cli(["list", ...flags, "--json"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "error", command: "contacts.list" });
    expect(requests).toHaveLength(0);
  });

  it.each(["true", "null"])("forwards JSON scalar %s without string coercion", async (value) => {
    const result = await cli([
      "list",
      "--custom-field",
      "active",
      "--custom-field-value",
      value,
      "--json",
    ]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(requests[0]?.url.searchParams.get("customFieldValue")).toBe(value);
  });

  it("keeps one-page JSONL bounded and quiet mode silent", async () => {
    const result = await cli(["list", "--jsonl"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(requests).toHaveLength(1);
    const quiet = await cli(["list", "--quiet"]);
    expect(quiet).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("shows the list's distinct names, memberships, channels, and activity times in human mode", async () => {
    const result = await cli(["list"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toMatch(/Name\s+Ada\n/);
    expect(result.stdout).toMatch(/Display name\s+Ada Lovelace/);
    expect(result.stdout).toMatch(/Channels\s+email/);
    expect(result.stdout).toContain(JSON.stringify(summary.lists));
    expect(result.stdout).toMatch(/Last active\s+2026-10-10T18:00:00.000Z/);
    expect(result.stdout).toMatch(/Created\s+2026-10-11T00:00:00.000Z/);
    expect(result.stdout).toContain(JSON.stringify(summary.customFields));
  });

  it("returns complete contact details and renders custom fields for humans", async () => {
    const result = await cli(["get", id, "--json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({ command: "contacts.get", data: contact });
    const human = await cli(["get", id]);
    expect(human).toMatchObject({ code: 0, stderr: "" });
    expect(human.stdout).toContain(id);
    expect(human.stdout).toContain(contact.avatar);
    expect(human.stdout).toContain(JSON.stringify(contact.identities));
    expect(human.stdout).toContain('"plan":"pro"');
  });

  it("keeps prior streamed records and resumes from a failed page's cursor", async () => {
    failSecondPage = "forbidden";
    const result = await cli(["list", "--all", "--jsonl"]);
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({ command: "contacts.list", data: { id } });
    expect(JSON.parse(result.stderr)).toMatchObject({
      type: "error",
      command: "contacts.list",
      reason: "ForbiddenError",
      status: 403,
      details: { cursor: "next-page" },
    });
    const { details } = JSON.parse(result.stderr);
    failSecondPage = false;
    const resumed = await cli(["list", "--all", "--jsonl", "--cursor", details.cursor]);
    expect(resumed).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(resumed.stdout)).toMatchObject({ data: { name: "Grace" } });
    expect(requests.map(({ url }) => url.searchParams.get("cursor"))).toEqual([
      null,
      "next-page",
      "next-page",
    ]);
  });

  it.each(["--json", "--jsonl"])(
    "reports the requested cursor on a bounded %s failure",
    async (mode) => {
      failSecondPage = "forbidden";
      const result = await cli(["list", "--cursor", "next-page", mode]);
      expect(result).toMatchObject({ code: 4, stdout: "" });
      expect(JSON.parse(result.stderr)).toMatchObject({
        schemaVersion: 1,
        type: "error",
        command: "contacts.list",
        reason: "ForbiddenError",
        status: 403,
        details: { cursor: "next-page" },
      });
    },
  );

  it("reports a null cursor when the first page fails", async () => {
    forbidden = true;
    const result = await cli(["list", "--all", "--jsonl"]);
    expect(result).toMatchObject({ code: 4, stdout: "" });
    expect(JSON.parse(result.stderr)).toMatchObject({ details: { cursor: null } });
  });

  it("preserves API recovery details alongside the failed page cursor", async () => {
    failSecondPage = "validation";
    const result = await cli(["list", "--all", "--jsonl"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ type: "result", data: { name: "Ada" } });
    expect(JSON.parse(result.stderr)).toMatchObject({
      type: "error",
      reason: "ValidationError",
      status: 422,
      details: { fields: { cursor: ["Invalid pagination cursor"] }, cursor: "next-page" },
      next: "Fix the listed fields before retrying.",
    });
  });

  it("retains the failed page cursor when the transport disconnects", async () => {
    failSecondPage = "transport";
    const result = await cli(["list", "--all", "--jsonl"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ type: "result", data: { name: "Ada" } });
    expect(JSON.parse(result.stderr)).toMatchObject({
      type: "error",
      command: "contacts.list",
      reason: "operational_failure",
      details: { cursor: "next-page" },
    });
  });
});
