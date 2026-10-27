import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { runCli } from "./support/run-cli";

const id = "jrny_7q2xk9mvt4znw8rh";
const AT = "2026-10-13T00:00:00.000Z";
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
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let source = "";
    for await (const chunk of req) source += chunk;
    requests.push({ method: req.method ?? "", url, body: source ? JSON.parse(source) : null });
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
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
  it.each(["inline", "file", "stdin"])("creates a journey from %s definition", async (mode) => {
    const file = join(configHome, "journey.json");
    await writeFile(file, JSON.stringify(definition));
    const result = await cli(
      [
        "journeys",
        "create",
        "--name",
        "Welcome",
        "--definition",
        mode === "inline" ? JSON.stringify(definition) : mode === "file" ? `@${file}` : "-",
        "--json",
      ],
      mode === "stdin" ? JSON.stringify(definition) : undefined,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ command: "journeys.create", data: journey });
    expect(requests[0]).toMatchObject({
      method: "POST",
      body: { name: "Welcome", definition },
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
        "--dry-run",
        "--json",
      ],
      { configHome },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({
      dryRun: true,
      action: "journeys.create",
    });
    expect(requests).toEqual([]);
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
