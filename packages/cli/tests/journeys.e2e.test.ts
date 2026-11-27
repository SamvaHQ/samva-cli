import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { createTestServer } from "./support/http-server";
import { runCli } from "./support/run-cli";

const id = "jrny_7q2xk9mvt4znw8rh";
const namespaceId = "ns_7q2xk9mvt4znw8rh";
const AT = "2026-10-13T00:00:00.000Z";
const recipeCatalogPath = "/v1/integrations/catalog/recipes";
const recipeReadinessPath = `${recipeCatalogPath}/post-delivery-check-in/readiness`;
const setupId = "2ba59ac9-2673-49fd-a67a-2579d98429b7";
const setupActivatePath = `${recipeCatalogPath}/post-delivery-check-in/setups/${setupId}/activate`;
const activation = {
  revision: "c21d852b-a28c-4ef8-abee-5ddb94a754d7",
  selection: { channel: "email", publicationId: "tpub_aaaaaaaaaaaaaaaa" },
};
const activated = {
  setup: {
    id: setupId,
    revision: "0c0df2a3-18e0-45cf-8e5b-ae5f87fb99c5",
    references: { ...activation.selection, journeyId: id },
    updatedAt: AT,
  },
  journey: { id, status: "active", publishedVersion: 1 },
};
const catalog = {
  recipes: [
    {
      id: "post-delivery-check-in",
      title: "Post-delivery check-in",
      trigger: "shopify.order_delivered",
      stopEvent: "shopify.refund_created",
      waitDays: 3,
      channels: ["email", "whatsapp"],
    },
  ],
  events: [],
};
const readiness = {
  ready: false,
  channel: "whatsapp",
  availability: { plan: "denied" },
  shopify: null,
  publication: null,
  email: null,
  whatsapp: null,
  reply: null,
};
const inputIssue = "Delivered order: storeName: is required";
const emailReadiness = {
  ready: false,
  channel: "email",
  availability: { plan: "granted" },
  shopify: null,
  publication: {
    id: "tpub_aaaaaaaaaaaaaaaa",
    templateId: "tmpl_aaaaaaaaaaaaaaaa",
    inputIssues: [
      inputIssue,
      "Ask the template assistant to read these from the order event or write fixed text.",
    ],
  },
  email: null,
  whatsapp: null,
  reply: null,
};
const definition = {
  trigger: { type: "contact.created" },
  rootNodeId: "done",
  nodes: { done: { type: "exit", config: {}, next: [] } },
};
const journey = {
  id,
  name: "Welcome",
  status: "draft",
  revision: "rev-1",
  draft: definition,
  publishedVersion: null,
  publishedAt: null,
  createdAt: AT,
  updatedAt: AT,
};
const run = (n: number) => ({
  id: `jrun_7q2xk9mvt4znw8r${n}`,
  journeyId: id,
  version: 1,
  contactId: "contact_7q2xk9mvt4znw8rh",
  status: "active",
  exitReason: null,
  failureReason: null,
  currentNodeId: "done",
  holdReason: null,
  holdUntil: null,
  trigger: { eventId: "cevt_7q2xk9mvt4znw8rh", eventName: "contact.created", properties: {} },
  enteredAt: AT,
  endedAt: null,
});

let configHome: string;
let apiUrl: string;
let close: () => Promise<void>;
let requests: Array<{ method: string; url: URL; body: unknown }>;
beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), "samva-cli-journeys-"));
  requests = [];
  const server = createTestServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let source = "";
    for await (const chunk of req) source += chunk;
    requests.push({ method: req.method ?? "", url, body: source ? JSON.parse(source) : null });
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === setupActivatePath && req.method === "POST") return reply(200, activated);
    if (url.pathname === recipeCatalogPath && req.method === "GET") return reply(200, catalog);
    if (url.pathname === recipeReadinessPath && req.method === "GET")
      return reply(200, url.searchParams.get("channel") === "email" ? emailReadiness : readiness);
    if (url.pathname === `/v1/journeys/${id}/publish`)
      return source.includes("stale")
        ? reply(409, { _tag: "ConflictError", message: "Revision is stale", resource: "Journey" })
        : reply(200, { ...journey, status: "active", publishedVersion: 1 });
    if (url.pathname === `/v1/journeys/${id}/runs`) {
      const second = url.searchParams.get("cursor") === "next-page";
      return reply(200, { items: [run(second ? 2 : 1)], nextCursor: second ? null : "next-page" });
    }
    if (url.pathname === `/v1/journeys/${id}` && req.method === "DELETE")
      return reply(200, { id, deleted: true });
    if (url.pathname === "/v1/journeys" && req.method === "POST") return reply(201, journey);
    if (url.pathname === "/v1/journeys" && req.method === "GET")
      return reply(200, { items: [], nextCursor: null });
    return reply(200, journey);
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
    env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "samva_sk_test_journeys" },
  });

describe("journeys CLI HTTP boundary", () => {
  it("filters a journey list by namespace", async () => {
    const result = await cli(["journeys", "list", "--namespace", namespaceId, "--json"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "journeys.list",
      data: { items: [], nextCursor: null },
    });
    expect(
      requests.map(({ method, url }) => [
        method,
        url.pathname,
        url.searchParams.get("namespaceId"),
      ]),
    ).toEqual([["GET", "/v1/journeys", namespaceId]]);
  });

  it("activates the exact reviewed setup revision and send selection", async () => {
    const result = await cli([
      "journeys",
      "recipe-setups",
      "activate",
      setupId,
      "--data",
      JSON.stringify(activation),
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "journeys.recipe-setups.activate",
      data: activated,
    });
    expect(requests.map(({ method, url, body }) => [method, url.pathname, body])).toEqual([
      ["POST", setupActivatePath, activation],
    ]);
  });
  it("reads the Shopify recipe catalog without requiring a configured journey", async () => {
    const result = await cli(["journeys", "recipes", "--json"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ command: "journeys.recipes", data: catalog });
    expect(
      requests.map(({ method, url, body }) => [method, url.pathname, url.search, body]),
    ).toEqual([["GET", recipeCatalogPath, "", null]]);
  });

  it("checks readiness for the selected WhatsApp resources and returns the blocked state", async () => {
    const result = await cli([
      "journeys",
      "readiness",
      "--channel",
      "whatsapp",
      "--publication-id",
      "tpub_aaaaaaaaaaaaaaaa",
      "--whatsapp-account-id",
      "waba_aaaaaaaaaaaaaaaa",
      "--registration-id",
      "treg_aaaaaaaaaaaaaaaa",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "journeys.readiness",
      data: readiness,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "GET", body: null });
    expect(requests[0]?.url.pathname).toBe(recipeReadinessPath);
    expect(Object.fromEntries(requests[0]?.url.searchParams ?? [])).toEqual({
      channel: "whatsapp",
      publicationId: "tpub_aaaaaaaaaaaaaaaa",
      whatsappAccountId: "waba_aaaaaaaaaaaaaaaa",
      registrationId: "treg_aaaaaaaaaaaaaaaa",
    });
  });

  it("names the publication's input issues in human output and keeps them in JSON", async () => {
    const args = ["journeys", "readiness", "--channel", "email"];
    const human = await cli([...args, "--publication-id", "tpub_aaaaaaaaaaaaaaaa"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("Publication input issues:");
    expect(human.stdout).toContain(`  - ${inputIssue}`);
    expect(human.stdout).toContain("Ask the template assistant to read these");

    const json = await cli([...args, "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      command: "journeys.readiness",
      data: emailReadiness,
    });
  });

  it("documents readiness flags and refuses an invalid channel before any request", async () => {
    const help = await cli(["journeys", "readiness", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--mailbox-endpoint-id");
    expect(help.stdout).toContain("samva journeys readiness --channel whatsapp --json");

    const refused = await cli(["journeys", "readiness", "--channel", "sms", "--json"]);
    expect(refused.code).not.toBe(0);
    expect(refused.stdout).toBe("");
    expect(requests).toEqual([]);
  });

  it.each([
    ["{", "--data must be valid JSON"],
    ["{}", "Invalid recipe --data"],
  ])("rejects recipe preview data %s before making a request", async (data, message) => {
    const result = await cli(["journeys", "recipe-preview", "--data", data, "--json"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
    expect(requests).toEqual([]);
  });

  it.each(["inline", "file", "stdin"])("creates a journey from %s definition", async (mode) => {
    const file = join(configHome, "journey.json");
    await writeFile(file, JSON.stringify(definition));
    const namespaced = mode === "stdin";
    const result = await cli(
      [
        "journeys",
        "create",
        "--name",
        "Welcome",
        "--definition",
        mode === "inline" ? JSON.stringify(definition) : mode === "file" ? `@${file}` : "-",
        ...(namespaced ? ["--namespace", namespaceId] : []),
        "--json",
      ],
      mode === "stdin" ? JSON.stringify(definition) : undefined,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ command: "journeys.create", data: journey });
    expect(requests[0]).toMatchObject({
      method: "POST",
      body: { name: "Welcome", definition, ...(namespaced ? { namespaceId } : {}) },
    });
  });

  it("previews a create offline without credentials or requests", async () => {
    const result = await runCli(
      [
        "journeys",
        "create",
        "--name",
        "W",
        "--definition",
        JSON.stringify(definition),
        "--namespace",
        namespaceId,
        "--dry-run",
        "--json",
      ],
      { configHome },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({
      dryRun: true,
      action: "journeys.create",
      request: { name: "W", namespaceId, definition },
    });
    expect(requests).toEqual([]);
  });

  it("validates order enrollment and immutable event bindings offline", async () => {
    const orderDefinition = {
      trigger: { type: "event", eventName: "shopify.order_delivered" },
      enrollment: { type: "shopify_order", shop: "preview.myshopify.com" },
      goal: { eventName: "shopify.refund_created" },
      rootNodeId: "send",
      nodes: {
        send: {
          type: "send_whatsapp",
          config: {
            template: "check-in",
            eventBindings: { order: "order.name" },
            flowActionDataBinding: "order",
          },
          next: [{ nodeId: "done" }],
        },
        done: { type: "exit", config: {}, next: [] },
      },
    };
    const result = await runCli(
      [
        "journeys",
        "create",
        "--name",
        "Order",
        "--definition",
        JSON.stringify(orderDefinition),
        "--dry-run",
        "--json",
      ],
      { configHome },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { request: { definition: orderDefinition } },
    });
    expect(requests).toEqual([]);
    orderDefinition.nodes.send.config.eventBindings.order = "order.unknown";
    const invalid = await runCli(
      [
        "journeys",
        "create",
        "--name",
        "Order",
        "--definition",
        JSON.stringify(orderDefinition),
        "--dry-run",
      ],
      { configHome },
    );
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain("Unknown Shopify event property");
  });

  it("refuses a definition that is not JSON before requesting", async () => {
    const result = await cli(["journeys", "create", "--name", "W", "--definition", "{", "--json"]);
    expect(result.code).toBe(2);
    expect(requests).toEqual([]);
  });

  it.each([
    [
      "an unknown trigger",
      { ...definition, trigger: { type: "contact.deleted" } },
      "JourneyTrigger",
    ],
    [
      "a root outside the graph",
      { ...definition, rootNodeId: "missing" },
      "The root must name a node",
    ],
    ["no nodes", { ...definition, nodes: {} }, "at least 1 entry"],
    [
      "event bindings with a contact trigger",
      {
        ...definition,
        rootNodeId: "send",
        nodes: {
          ...definition.nodes,
          send: {
            type: "send_whatsapp",
            config: { template: "check-in", eventBindings: { order: "order.name" } },
            next: [{ nodeId: "done" }],
          },
        },
      },
      "WhatsApp event bindings require an event trigger",
    ],
    [
      "order enrollment with a contact trigger",
      { ...definition, enrollment: { type: "shopify_order", shop: "preview.myshopify.com" } },
      "shopify_order enrollment requires a Shopify order event trigger",
    ],
    [
      "order enrollment with a checkout trigger",
      {
        ...definition,
        trigger: { type: "event", eventName: "shopify.checkout_started" },
        enrollment: { type: "shopify_order", shop: "preview.myshopify.com" },
      },
      "shopify_order enrollment requires a Shopify order event trigger",
    ],
    [
      "an unreachable node",
      {
        ...definition,
        nodes: { ...definition.nodes, orphan: { type: "exit", config: {}, next: [] } },
      },
      "Node is unreachable from the root",
    ],
  ])("validates the whole definition offline and refuses %s", async (_, invalid, reason) => {
    const dry = await runCli(
      ["journeys", "create", "--name", "W", "--definition", JSON.stringify(invalid), "--dry-run"],
      { configHome },
    );
    expect(dry.code).toBe(2);
    expect(dry.stderr).toContain("not a valid journey definition");
    expect(dry.stderr).toContain(reason);
    const draft = await cli([
      "journeys",
      "draft",
      id,
      "--revision",
      "rev-1",
      "--definition",
      JSON.stringify(invalid),
    ]);
    expect(draft.code).toBe(2);
    expect(requests).toEqual([]);
  });

  it("replaces the draft and publishes with the revision the caller read", async () => {
    const draft = await cli([
      "journeys",
      "draft",
      id,
      "--revision",
      "rev-1",
      "--definition",
      JSON.stringify(definition),
      "--json",
    ]);
    expect(draft.code).toBe(0);
    const publish = await cli(["journeys", "publish", id, "--revision", "rev-2", "--json"]);
    expect(publish.code).toBe(0);
    expect(requests.map(({ method, url, body }) => [method, url.pathname, body])).toEqual([
      ["PUT", `/v1/journeys/${id}/draft`, { revision: "rev-1", definition }],
      ["POST", `/v1/journeys/${id}/publish`, { revision: "rev-2" }],
    ]);
  });

  it("surfaces a stale revision as a typed error", async () => {
    const result = await cli(["journeys", "publish", id, "--revision", "stale", "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ reason: "ConflictError", status: 409 });
  });

  it("requires --yes to delete and previews with --dry-run", async () => {
    const refused = await cli(["journeys", "delete", id, "--json"]);
    expect(refused.code).toBe(2);
    expect(requests).toEqual([]);
    const preview = await cli(["journeys", "delete", id, "--dry-run", "--json"]);
    expect(JSON.parse(preview.stdout).data).toEqual({
      dryRun: true,
      action: "journeys.delete",
      id,
    });
    const deleted = await cli(["journeys", "delete", id, "--yes", "--json"]);
    expect(deleted.code).toBe(0);
    expect(requests.map(({ method }) => method)).toEqual(["DELETE"]);
  });

  it("streams every run page with JSONL and refuses --all without it", async () => {
    const refused = await cli(["journeys", "runs", "list", id, "--all", "--json"]);
    expect(refused.code).toBe(2);
    expect(requests).toEqual([]);
    const result = await cli([
      "journeys",
      "runs",
      "list",
      id,
      "--status",
      "active",
      "--all",
      "--jsonl",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim().split("\n")).toHaveLength(2);
    expect(requests[0]?.url.searchParams.get("status")).toBe("active");
    expect(requests[1]?.url.searchParams.get("cursor")).toBe("next-page");
  });
});
