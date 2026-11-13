import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest";

import { runCli } from "./support/run-cli";

const now = "2026-11-12T00:00:00.000Z";
const template = {
  id: "tmpl_1234567890abcdef",
  namespaceId: null,
  shared: false,
  projectId: "tproj_1234567890abcdef",
  entryPath: "templates/welcome.tsx",
  name: "Coffee welcome",
  slug: "coffee-welcome",
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
const suggestion = (id: string, name: string) => ({
  galleryTemplateId: id,
  slug: id,
  name,
  description: `${name} design`,
  intent: "welcome",
  tags: [],
  structure: "single-column",
  imagery: "none",
  reason: `${name} fits a welcome email`,
});
const suggestions = [
  suggestion("gal_one", "Warm welcome"),
  suggestion("gal_two", "Plain welcome"),
  suggestion("gal_three", "Bold welcome"),
];
const ask = "Adapt this design to: Welcome email for a coffee subscription";
const recreation = { status: "missing", company: "Acme" };
const whoami = {
  organization: {
    id: "org_3m8p2vqz6ty4bnkd",
    slug: "acme",
    name: "Acme",
    hostedMailDomain: "acme.samva.email",
  },
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
let createdBody: unknown;
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
  const [status, body] =
    req.url === "/v1/whoami"
      ? [200, whoami]
      : req.url === "/v1/templates/suggestions"
        ? [200, { suggestions, recreation }]
        : [201, createdBody];
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
});
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "samva-from-brief-"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await rm(home, { recursive: true, force: true });
});
beforeEach(() => {
  requests.length = 0;
  createdBody = {
    template,
    startedFrom: suggestions[0],
    alternatives: suggestions.slice(1),
    recreation,
    ask,
  };
});

const run = (command: string, args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  runCli(["templates", command, ...args], {
    configHome: home,
    env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "sk_test_from_brief", ...env },
  });

const posted = (path: string) => requests.filter((request) => request.path === path);

describe("samva templates suggest", () => {
  it("prints each suggestion with its reason and the recreation line", async () => {
    const result = await run("suggest", ["Welcome email for a coffee subscription"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("gal_one");
    expect(result.stdout).toContain("Warm welcome fits a welcome email");
    expect(result.stdout).toContain("gal_three");
    expect(result.stdout).toContain("no recreation of Acme's email");
    expect(posted("/v1/templates/suggestions")[0]).toMatchObject({
      method: "POST",
      body: { brief: "Welcome email for a coffee subscription" },
    });
  });

  it("prints the API result with --json", async () => {
    const result = await run("suggest", ["Welcome email", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data).toEqual({ suggestions, recreation });
  });
});

describe("samva templates from-brief", () => {
  it("sends the brief, name, gallery template, and an idempotency key", async () => {
    const result = await run("from-brief", [
      "Welcome email for a coffee subscription",
      "--name",
      "Coffee welcome",
      "--gallery-template",
      "gal_two",
      "--idempotency-key",
      "brief-1",
    ]);
    expect(result.code, result.stderr).toBe(0);
    const [request] = posted("/v1/templates/from-brief");
    expect(request).toMatchObject({
      method: "POST",
      idempotencyKey: "brief-1",
      body: {
        brief: "Welcome email for a coffee subscription",
        name: "Coffee welcome",
        galleryTemplateId: "gal_two",
      },
    });
    expect(result.stdout).toContain(template.id);
    expect(result.stdout).toContain("Warm welcome (gal_one)");
  });

  it("says the gallery has no recreation and which design it started from", async () => {
    const result = await run("from-brief", ["An Acme welcome"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "the gallery has no recreation of Acme's email, so it starts from the closest design, Warm welcome",
    );
    expect(result.stdout).toContain(ask);
    expect(typeof posted("/v1/templates/from-brief")[0]?.idempotencyKey).toBe("string");
    expect(posted("/v1/templates/from-brief")[0]?.body).toEqual({ brief: "An Acme welcome" });
  });

  it("says a kind-differs recreation starts from the company's other recreation", async () => {
    createdBody = {
      ...(createdBody as object),
      recreation: {
        status: "kind-differs",
        company: "Acme",
        galleryTemplateId: "gal_one",
        recreationName: "Acme receipt",
      },
    };
    const result = await run("from-brief", ["An Acme welcome"]);
    expect(result.stdout).toContain("other recreation, Acme receipt, for its look");
  });

  it("emits a stable JSON result with the editor link", async () => {
    const result = await run("from-brief", ["An Acme welcome", "--json"], {
      SAMVA_API_URL: apiUrl.replace("127.0.0.1", "api.localhost"),
    });
    expect(result.code, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout).data;
    expect(Object.keys(data).sort()).toEqual([
      "alternatives",
      "ask",
      "editorUrl",
      "recreation",
      "startedFrom",
      "template",
    ]);
    expect(data.template).toEqual({ id: template.id, name: template.name });
    expect(data.recreation).toEqual(recreation);
    expect(data.editorUrl).toBe(
      `${apiUrl.replace("127.0.0.1", "localhost")}/dashboard/acme/templates/${template.id}/edit?ask=${encodeURIComponent(ask)}`,
    );
  });

  it("rejects an out-of-range key before any request", async () => {
    const result = await run("from-brief", ["x", "--idempotency-key", "x".repeat(256)]);
    expect(result.code).not.toBe(0);
    expect(requests).toEqual([]);
  });
});
