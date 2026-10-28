import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest";

import { editorPath, webOriginForApi } from "../src/commands/templates/from-website-command";
import { runCli } from "./support/run-cli";

const now = "2026-10-18T00:00:00.000Z";
const template = {
  id: "tmpl_1234567890abcdef",
  namespaceId: null,
  shared: false,
  projectId: "tproj_1234567890abcdef",
  entryPath: "templates/welcome.tsx",
  name: "Example welcome",
  slug: "example-welcome",
  familyId: null,
  channel: "email",
  description: null,
  category: null,
  email: { subject: "Welcome aboard", preheader: null, headers: null },
  sms: null,
  whatsapp: null,
  publicationId: null,
  brand: null,
  inputContractId: null,
  inputSchema: null,
  usageCount: 0,
  lastUsedAt: null,
  status: "draft",
  isActive: true,
  publishedAt: null,
  fromDefault: null,
  replyToDefault: null,
  trackingDefault: null,
  createdAt: now,
  updatedAt: now,
};
const ask = "Research https://example.com and rebuild this template's theme to match it.";
const created = { template, website: { url: "https://example.com/", host: "example.com" }, ask };
const whoami = {
  organization: { id: "org_3m8p2vqz6ty4bnkd", slug: "acme", name: "Acme" },
  credential: {
    type: "apiKey",
    id: "key_1234567890abcdef",
    name: "ci",
    start: "sk_",
    access: { mode: "full" },
  },
};

interface Recorded {
  readonly method: string;
  readonly idempotencyKey: string | undefined;
  readonly path: string;
  readonly body: Record<string, unknown> | undefined;
}
let apiUrl = "";
let home = "";
const requests: Array<Recorded> = [];
let reply: { status: number; body: unknown } = { status: 201, body: created };
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  requests.push({
    method: req.method!,
    path: req.url!,
    body: raw ? JSON.parse(raw) : undefined,
    idempotencyKey:
      typeof req.headers["idempotency-key"] === "string"
        ? req.headers["idempotency-key"]
        : undefined,
  });
  const [status, body] = req.url === "/v1/whoami" ? [200, whoami] : [reply.status, reply.body];
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
});
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "samva-from-website-"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await rm(home, { recursive: true, force: true });
});
beforeEach(() => {
  requests.length = 0;
  reply = { status: 201, body: created };
});

const run = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  runCli(["templates", "from-website", ...args], {
    configHome: home,
    env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "sk_test_from_website", ...env },
  });

const posted = () => requests.filter((request) => request.path === "/v1/templates/from-website");

describe("webOriginForApi", () => {
  it("drops the api label and refuses hosts that do not follow it", () => {
    expect(webOriginForApi("https://api.samva.dev")).toBe("https://samva.dev");
    expect(webOriginForApi("https://api.samva.localhost")).toBe("https://samva.localhost");
    expect(webOriginForApi("http://127.0.0.1:4000")).toBeNull();
    expect(webOriginForApi("not a url")).toBeNull();
  });

  it("encodes the ask into the editor path", () => {
    expect(editorPath("acme", "tmpl_1", "a b&c")).toBe(
      "/dashboard/acme/templates/tmpl_1/edit?ask=a%20b%26c",
    );
  });
});

describe("samva templates from-website", () => {
  it("prints the template, host, and ask when the API URL has no dashboard origin", async () => {
    const result = await run(["example.com", "--name", "Example welcome"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(template.id);
    expect(result.stdout).toContain("example.com");
    expect(result.stdout).toContain(ask);
    expect(result.stdout).toContain("applies only when you approve it");
    expect(posted()[0]).toMatchObject({
      method: "POST",
      body: { url: "example.com", name: "Example welcome" },
    });
  });

  it("emits a stable JSON result with the editor link", async () => {
    const result = await run(["example.com", "--json"], {
      SAMVA_API_URL: apiUrl.replace("127.0.0.1", "api.localhost"),
    });
    expect(result.code, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout).data;
    expect(Object.keys(data).sort()).toEqual(["ask", "editorUrl", "template", "website"]);
    expect(data.template).toEqual({ id: template.id, name: template.name });
    expect(data.website).toEqual(created.website);
    expect(data.editorUrl).toBe(
      `${apiUrl.replace("127.0.0.1", "localhost")}/dashboard/acme/templates/${template.id}/edit?ask=${encodeURIComponent(ask)}`,
    );
  });

  it("passes a refusal message through verbatim with a nonzero exit", async () => {
    const message = "That address does not answer: no DNS record was found for nope.invalid.";
    reply = { status: 422, body: { _tag: "ValidationError", message } };
    const result = await run(["nope.invalid"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stdout).toBe("");
  });

  it("generates a key per run and honors --idempotency-key", async () => {
    await run(["example.com"]);
    await run(["example.com"]);
    await run(["example.com", "--idempotency-key", "brand-1"]);
    const [first, second, third] = posted().map((request) => request.idempotencyKey);
    expect(typeof first).toBe("string");
    expect(first).not.toBe(second);
    expect(third).toBe("brand-1");
  });

  it("rejects an out-of-range key before any request", async () => {
    const result = await run(["example.com", "--idempotency-key", "x".repeat(256)]);
    expect(result.code).not.toBe(0);
    expect(requests).toEqual([]);
  });
});
