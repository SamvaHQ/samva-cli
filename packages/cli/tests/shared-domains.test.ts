// Sharing flags must survive real CLI parsing and the generated SDK's HTTP serialization.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest";

import { emailDomainFixture } from "./support/fixtures";
import { runCli } from "./support/run-cli";

const id = "dom_1234567890abcdefgh";
const requests: Array<{ method: string; path: string; body: unknown }> = [];
let home = "";
let apiUrl = "";
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  requests.push({ method: req.method!, path: req.url!, body: raw ? JSON.parse(raw) : undefined });
  const domain = emailDomainFixture({ shared: true });
  let body: unknown;
  if (req.method === "GET") body = { items: [domain], nextCursor: null };
  else if (req.url!.endsWith("/default")) body = { success: true, message: "Default sender set" };
  else if (req.method === "PATCH")
    body = {
      id,
      shared: false,
      openTracking: null,
      clickTracking: null,
      replyTo: null,
      topicId: null,
      footerEnabled: null,
      brandSlug: null,
    };
  else body = { ...domain, verifiedAt: null, dnsRecords: [] };
  res.writeHead(req.method === "POST" && req.url === "/v1/email/domains" ? 201 : 200, {
    "content-type": "application/json",
  });
  res.end(JSON.stringify(body));
});
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "samva-shared-domains-"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await rm(home, { recursive: true, force: true });
});
beforeEach(() => {
  requests.length = 0;
});
const run = (args: string[]) =>
  runCli(["email", ...args], {
    configHome: home,
    env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "sk_test_shared" },
  });

describe("shared domains", () => {
  it("creates, filters and unshares through the API", async () => {
    for (const args of [
      ["domains", "add", "--domain", "example.com", "--shared", "--json"],
      ["domains", "list", "--shared", "true", "--json"],
      ["domains", "update", id, "--shared", "false", "--json"],
    ]) {
      const result = await run(args);
      expect(result.code, result.stderr).toBe(0);
    }
    expect(requests).toEqual([
      { method: "POST", path: "/v1/email/domains", body: { domain: "example.com", shared: true } },
      { method: "GET", path: "/v1/email/domains?shared=true", body: undefined },
      { method: "PATCH", path: `/v1/email/domains/${id}/config`, body: { shared: false } },
    ]);
  });
  it("previews sharing without requesting and refuses a namespaced shared domain", async () => {
    const preview = await run([
      "domains",
      "add",
      "--domain",
      "example.com",
      "--shared",
      "--dry-run",
      "--json",
    ]);
    expect(preview.code, preview.stderr).toBe(0);
    expect(JSON.parse(preview.stdout).data).toMatchObject({ shared: true, dryRun: true });
    const refused = await run([
      "domains",
      "add",
      "--domain",
      "example.com",
      "--shared",
      "--namespace",
      "ns_1234567890123456",
      "--json",
    ]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("shared_namespace_conflict");
    expect(requests).toEqual([]);
  });
  it("sets the credential scope's default with an empty selection payload", async () => {
    const result = await run(["senders", "set-default", "sender_1234567890123456", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/v1/email/senders/sender_1234567890123456/default",
        body: {},
      },
    ]);
  });
  it("selects a namespace's shared default sender", async () => {
    const result = await run([
      "senders",
      "set-default",
      "sender_1234567890123456",
      "--namespace",
      "ns_1234567890123456",
      "--json",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/v1/email/senders/sender_1234567890123456/default",
        body: { namespaceId: "ns_1234567890123456" },
      },
    ]);
  });
});
