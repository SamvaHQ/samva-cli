import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { type AddressInfo, createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { printJson, printJsonDocument } from "../src/lib/output";
import { runCli } from "./support/run-cli";

// Human mode is formatted text. A command that prints a bare JSON document there fails the
// guard in `printJson`, and this file proves each command that once did prints rows instead.

const now = "2026-10-13T00:00:00.000Z";
const webhook = {
  id: "wep_1234567890abcdef",
  name: "Delivery",
  url: "https://example.com/hook",
  eventTypes: ["message.delivered", "message.bounced"],
  channels: ["email"],
  mailboxIds: null,
  namespaceId: null,
  status: "active",
  hasCustomHeaders: false,
  failureStartedAt: null,
  lastSucceededAt: null,
  createdAt: now,
  updatedAt: now,
};
const attempt = {
  id: "whatt_1234567890abcdef",
  deliveryId: "whdel_1234567890abcdef",
  kind: "automatic",
  attemptNumber: 1,
  classification: "http-error",
  attemptedAt: now,
  responseStatus: 503,
  responseHeaders: { server: "edge" },
  durationMs: 240,
  errorCode: "http_503",
  errorMessage: "Service Unavailable",
  createdAt: now,
};
const delivery = {
  id: "whdel_1234567890abcdef",
  eventId: "whevt_1234567890abcdef",
  eventType: "message.delivered",
  occurredAt: now,
  endpointId: webhook.id,
  status: "pending",
  automaticAttempts: 1,
  nextAttemptAt: "2026-10-13T00:05:00.000Z",
  completedAt: null,
  createdAt: now,
  updatedAt: now,
  attempts: [attempt],
};
const template = {
  id: "tmpl_1234567890abcdef",
  namespaceId: null,
  shared: false,
  projectId: "tproj_1234567890abcdef",
  entryPath: "templates/welcome.tsx",
  name: "Welcome",
  slug: "welcome",
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
const usage = {
  usage: { periodStart: now, periodEnd: now, emailCount: 7, totalMessages: 9 },
  billing: {
    currency: "USD",
    planName: "Growth",
    includedCredits: 50000,
    usedCredits: 83,
    overageCredits: 0,
    overageCost: 0,
    includedAiCredits: 10000,
    usedAiCredits: 12,
    overageAiCredits: 0,
    overageAiCost: 0,
    aiPackCredits: 2500,
    aiResetsAt: null,
    creditsResetsAt: null,
  },
};
const apiKey = {
  id: "key_1234567890abcdef",
  name: "ci",
  start: "samva_sk_live_",
  end: "_test",
  description: "CI sender",
  createdAt: now,
  expiresAt: null,
  lastUsedAt: null,
  isActive: true,
  access: { mode: "restricted", resources: { email: "write" } },
  owner: { id: "user_1", name: "Ada Lovelace", email: "ada@example.com" },
};
const day = (date: string) => ({ date, pending: 1, delivered: 2, exhausted: 3, cancelled: 4 });

const domain = {
  id: "dom_1234567890abcdef",
  namespaceId: null,
  domain: "example.com",
  phase: "ready",
  isDefault: true,
  deliverability: { bounceRate: 0, complaintRate: 0, windowSends: 0, sendingStatus: "unknown" },
  series: Array.from({ length: 14 }, () => 0),
  createdAt: now,
  updatedAt: now,
};
const routes: Record<string, unknown> = {
  "GET /v1/webhooks/wep_1234567890abcdef/logs": { items: [delivery], nextCursor: "next_page" },
  "GET /v1/webhooks/wep_1234567890abcdef/stats": {
    total: 10,
    pending: 1,
    delivered: 2,
    exhausted: 3,
    cancelled: 4,
    daily: [day("2026-10-12"), day("2026-10-13")],
  },
  "POST /v1/webhooks/wep_1234567890abcdef/deliveries/whdel_1234567890abcdef/redeliver": {
    accepted: true,
    deliveryId: delivery.id,
    attemptId: attempt.id,
    outcome: "failed",
  },
  "PATCH /v1/webhooks/wep_1234567890abcdef": { ...webhook, name: "Renamed" },
  "GET /v1/organizations/usage": usage,
  "GET /v1/api-keys": { items: [apiKey], nextCursor: "next_page" },
  "GET /v1/api-keys/key_1234567890abcdef": apiKey,
  "GET /v1/whoami": {
    organization: { id: "org_3m8p2vqz6ty4bnkd", slug: "acme", name: "Acme" },
    credential: {
      type: "apiKey",
      id: apiKey.id,
      name: apiKey.name,
      start: apiKey.start,
      access: apiKey.access,
    },
  },
  "GET /v1/templates/tmpl_1234567890abcdef": template,
  "POST /v1/templates": template,
  "PATCH /v1/templates/tmpl_1234567890abcdef": { ...template, name: "Renamed" },
  "DELETE /v1/templates/tmpl_1234567890abcdef": { success: true },
  "GET /v1/email/domains": { items: [domain], nextCursor: null },
  "POST /v1/email/domains/dom_1234567890abcdef/default": {
    success: true,
    message: "Default sending domain set",
  },
  "POST /v1/email/senders/sender_1234567890abcdef/default": {
    success: true,
    message: "Organization default sender set",
  },
};

let server: Server;
let env: Record<string, string>;
let home = "";
const unmatched: Array<string> = [];

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "samva-human-output-"));
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const key = `${req.method} ${(req.url ?? "").split("?")[0]}`;
      const body = routes[key];
      if (body === undefined) unmatched.push(key);
      res.writeHead(body === undefined ? 404 : key === "POST /v1/templates" ? 201 : 200, {
        "content-type": "application/json",
      });
      res.end(
        JSON.stringify(body ?? { _tag: "ResourceNotFoundError", message: `no route ${key}` }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  env = { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: `http://127.0.0.1:${port}` };
});

beforeEach(() => {
  unmatched.length = 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
});

const bareJson = (stdout: string) => {
  try {
    const value: unknown = JSON.parse(stdout);
    return Predicate.isObject(value);
  } catch {
    return false;
  }
};

const wep = webhook.id;
const payload = (value: unknown) => JSON.stringify(value);

describe("human output is formatted, not a bare JSON document", () => {
  it.each([
    [
      "webhooks logs",
      ["webhooks", "logs", wep],
      [
        delivery.id,
        "message.delivered",
        "HTTP 503",
        "http_503: Service Unavailable",
        "server: edge",
        "next_page",
      ],
    ],
    [
      "webhooks stats",
      ["webhooks", "stats", wep],
      ["Total", "2026-10-13", "1 pending, 2 delivered, 3 exhausted, 4 cancelled"],
    ],
    [
      "webhooks retry",
      ["webhooks", "retry", wep, delivery.id],
      ["Retry failed", attempt.id, "Outcome"],
    ],
    [
      "webhooks update",
      ["webhooks", "update", wep, "--data", payload({ name: "Renamed" })],
      ["Renamed", "message.delivered, message.bounced", "https://example.com/hook"],
    ],
    [
      "webhooks create --dry-run",
      [
        "webhooks",
        "create",
        "--dry-run",
        "--data",
        payload({
          name: "Delivery",
          url: "https://example.com/hook",
          eventTypes: ["message.delivered"],
        }),
      ],
      ["webhooks.create", "Delivery", "message.delivered"],
    ],
    [
      "webhooks update --dry-run",
      ["webhooks", "update", wep, "--dry-run", "--data", payload({ name: "Renamed" })],
      ["webhooks.update", wep, "Renamed"],
    ],
    [
      "api-keys list",
      ["api-keys", "list"],
      [apiKey.id, "restricted (email:write)", "Ada Lovelace", "next_page"],
    ],
    [
      "api-keys get",
      ["api-keys", "get", apiKey.id],
      ["CI sender", "restricted (email:write)", "active"],
    ],
    ["org current under an API key", ["org", "current"], ["acme"]],
    [
      "org usage",
      ["org", "usage"],
      [
        "Emails",
        "7",
        "Messages",
        "9",
        "Growth",
        "Sending credits",
        "83 of 50000",
        "AI credits",
        "12 of 10000",
        "AI credits from packs",
        "2500",
      ],
    ],
    [
      "templates get",
      ["templates", "get", template.id],
      ["Welcome", "Welcome aboard", template.entryPath],
    ],
    [
      "templates create",
      [
        "templates",
        "create",
        "--data",
        payload({ name: "Welcome", projectName: "welcome", idempotencyKey: "welcome-v1" }),
      ],
      ["Welcome", template.id],
    ],
    [
      "templates create --dry-run",
      [
        "templates",
        "create",
        "--dry-run",
        "--data",
        payload({ name: "Welcome", projectName: "welcome", idempotencyKey: "welcome-v1" }),
      ],
      ["templates.create", "Welcome"],
    ],
    [
      "templates update",
      ["templates", "update", template.id, "--data", payload({ name: "Renamed" })],
      ["Renamed", template.id],
    ],
    [
      "templates update --dry-run",
      ["templates", "update", template.id, "--dry-run", "--data", payload({ name: "Renamed" })],
      ["templates.update", template.id, "Renamed"],
    ],
    [
      "templates update --dry-run accepts tracking defaults",
      [
        "templates",
        "update",
        template.id,
        "--dry-run",
        "--data",
        payload({ trackingDefault: { opens: false, clicks: false } }),
      ],
      ["templates.update", "Data tracking default opens", "Data tracking default clicks", "false"],
    ],
    [
      "templates update --dry-run clears tracking defaults",
      [
        "templates",
        "update",
        template.id,
        "--dry-run",
        "--data",
        payload({ trackingDefault: null }),
      ],
      ["templates.update", "Data tracking default", "null"],
    ],
    ["templates remove", ["templates", "remove", template.id, "--yes"], ["Removed", "true"]],
    [
      "templates update --dry-run shows cleared fields",
      [
        "templates",
        "update",
        template.id,
        "--dry-run",
        "--data",
        payload({ description: null, replyToDefault: [] }),
      ],
      ["Data description ", "Data reply to default ", "null\n", "[]"],
    ],
    [
      "webhooks update --dry-run shows an emptied object",
      ["webhooks", "update", wep, "--dry-run", "--data", payload({ headers: {} })],
      ["Headers  {}"],
    ],
    ["email domains list", ["email", "domains", "list"], ["example.com", "Default    yes"]],
    [
      "email domains set-default",
      ["email", "domains", "set-default", "dom_1234567890abcdef"],
      ["dom_1234567890abcdef", "is now the default domain"],
    ],
    [
      "email domains set-default --dry-run",
      ["email", "domains", "set-default", "dom_1234567890abcdef", "--dry-run"],
      ["Would make domain dom_1234567890abcdef the default domain"],
    ],
    [
      "email senders set-default",
      ["email", "senders", "set-default", "sender_1234567890abcdef"],
      ["sender_1234567890abcdef", "is now the default sender"],
    ],
    [
      "email senders set-default --dry-run",
      ["email", "senders", "set-default", "sender_1234567890abcdef", "--dry-run"],
      ["Would make sender sender_1234567890abcdef the default sender"],
    ],
    [
      "mailboxes actions approve --dry-run",
      [
        "mailboxes",
        "actions",
        "approve",
        "mbx_1234567890123456",
        "mbxact_1234567890abcdef",
        "--dry-run",
      ],
      ["Would approve", "mbxact_1234567890abcdef"],
    ],
    [
      "mailboxes actions deny --dry-run",
      [
        "mailboxes",
        "actions",
        "deny",
        "mbx_1234567890123456",
        "mbxact_1234567890abcdef",
        "--dry-run",
      ],
      ["Would deny", "Denied by reviewer."],
    ],
  ] as const)("%s", async (_name, args, facts) => {
    const result = await runCli([...args], { configHome: home, env });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(bareJson(result.stdout)).toBe(false);
    for (const fact of facts) expect(result.stdout).toContain(fact);
    expect(unmatched).toEqual([]);
  });
});

describe("the raw-JSON guard", () => {
  it("refuses printJson in human mode and allows printJsonDocument", async () => {
    // The vitest process has no --json or --jsonl, so it is in human mode.
    await expect(Effect.runPromise(printJson({ a: 1 }))).rejects.toThrow(/raw JSON in human mode/);
    await expect(Effect.runPromise(printJsonDocument({ a: 1 }))).resolves.toBeUndefined();
  });

  it("finds no output-mode selector other than --json, --jsonl, and --quiet", () => {
    // A command that reads a "json" value from another flag must route its output through
    // printJsonDocument, because printJson only admits the global output modes.
    const sourceRoot = fileURLToPath(new URL("../src/commands", import.meta.url));
    const files = (dir: string): Array<string> =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? files(join(dir, entry.name))
          : entry.name.endsWith(".ts")
            ? [join(dir, entry.name)]
            : [],
      );
    const selectors = files(sourceRoot)
      .filter((file) => /"json"/.test(readFileSync(file, "utf8")))
      .map((file) => relative(sourceRoot, file))
      .sort();
    expect(selectors).toEqual([
      // reads the global output mode from argv
      "extensions.ts",
      "mailboxes-events.ts",
      // --format json, routed through printJsonDocument
      "templates/render-command.ts",
    ]);
  });

  it("limits JSON-by-design output to the commands listed here", () => {
    // Each entry returns its complete result as JSON because the next call consumes it.
    const jsonByDesign: Record<string, string> = {
      "commands/topic-issues.ts":
        "topics issues returns complete workspace revisions, saved pins, and diagnostics consumed by the next fenced call",
      "commands/templates/workspace.ts":
        "templates workspace * returns revisions, digests, and diagnostics that are inputs to the next call (packages/cli/AGENTS.md)",
      "commands/templates/render-command.ts":
        "templates render --format json selects JSON as the render format without selecting a machine output mode",
    };
    const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
    const files = (dir: string): Array<string> =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? files(join(dir, entry.name))
          : entry.name.endsWith(".ts")
            ? [join(dir, entry.name)]
            : [],
      );
    const users = files(sourceRoot)
      .filter((file) => !file.endsWith(join("lib", "output.ts")))
      .filter((file) =>
        /\bprintJsonDocument\(|\bprintJsonDocument\b[^(]/.test(readFileSync(file, "utf8")),
      )
      .map((file) => relative(sourceRoot, file));
    expect(users.sort()).toEqual(Object.keys(jsonByDesign).sort());
  });
});
