import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest";
import { DEFAULT_AGENT_DEFINITION } from "@samva/core/agents/definition";

import { runCli } from "./support/run-cli";

const id = "agt_1234567890123456";
const draft = { name: "Shop assistant", setupJob: "store" };
const agent = {
  id,
  name: draft.name,
  setupJob: draft.setupJob,
  namespaceId: null,
  revision: "revision-1",
  draft: DEFAULT_AGENT_DEFINITION,
  publishedVersion: null,
  publishedAt: null,
  pausedAt: null,
  monthlySpendCapDollars: null,
  spend: { month: "2026-11", spentDollars: 0, capReachedAt: null },
  createdAt: "2026-11-09T00:00:00.000Z",
  updatedAt: "2026-11-09T00:00:00.000Z",
};
let home = "";
let apiUrl = "";
let status = 200;
let getBody: unknown = agent;
let responseBody: unknown = agent;
let requests: Array<{ method: string; path: string; body: unknown }> = [];
const server = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  requests.push({
    method: request.method!,
    path: request.url!,
    body: raw ? JSON.parse(raw) : undefined,
  });
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(request.method === "GET" ? getBody : responseBody));
});
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "samva-cli-agent-manage-"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP port");
  apiUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(home, { recursive: true });
});
beforeEach(() => {
  requests = [];
  status = 200;
  getBody = agent;
  responseBody = agent;
});
const cli = (args: ReadonlyArray<string>, stdin?: string) =>
  runCli(["agents", ...args], {
    configHome: home,
    env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "samva_sk_test_agents" },
    stdin,
  });

describe("agent inspection", () => {
  it("gets the full agent including its draft and revision as JSON", async () => {
    const run = await cli(["get", id, "--json"]);
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ command: "agents.get", data: agent });
    expect(requests).toEqual([{ method: "GET", path: `/v1/agents/${id}`, body: undefined }]);
  });
  it("prints readable status without dumping the draft", async () => {
    const run = await cli(["get", id]);
    expect(run.code, run.stderr).toBe(0);
    for (const text of [
      id,
      "Shop assistant",
      "Setup job",
      "store",
      "organization",
      "revision-1",
      "unpublished",
      "Paused",
      "no",
      "Monthly spend cap",
      "none",
      "Spent this month",
      "$0",
    ])
      expect(run.stdout).toContain(text);
    expect(run.stdout).not.toContain(JSON.stringify(agent.draft));
  });
  it("shows publication, owner, credits, and spend-cap pauses", async () => {
    getBody = {
      ...agent,
      namespaceId: "ns_1234567890123456",
      publishedVersion: 3,
      publishedAt: agent.createdAt,
      pausedAt: agent.createdAt,
      creditsPausedAt: agent.createdAt,
      monthlySpendCapDollars: 25,
      spend: { ...agent.spend, spentDollars: 25, capReachedAt: agent.createdAt },
    };
    const run = await cli(["get", id]);
    expect(run.code, run.stderr).toBe(0);
    for (const text of [
      "ns_1234567890123456",
      "3",
      agent.createdAt,
      "owner pause",
      "credits pause",
      "spend cap",
      "$25",
    ])
      expect(run.stdout).toContain(text);
  });
  it("drops the spend-cap pause once the cap is raised above this month's spend", async () => {
    getBody = {
      ...agent,
      monthlySpendCapDollars: 50,
      spend: { ...agent.spend, spentDollars: 25, capReachedAt: agent.createdAt },
    };
    const run = await cli(["get", id]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/^Paused\s+no$/m);
  });
});

describe("agent metadata updates", () => {
  it("patches a name and dollar cap and returns the full agent", async () => {
    responseBody = { ...agent, name: "Renamed", monthlySpendCapDollars: 12.34 };
    const run = await cli([
      "update",
      id,
      "--name",
      "Renamed",
      "--monthly-spend-cap",
      "12.34",
      "--json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ command: "agents.update", data: responseBody });
    expect(requests).toEqual([
      {
        method: "PATCH",
        path: `/v1/agents/${id}`,
        body: { name: "Renamed", monthlySpendCapDollars: 12.34 },
      },
    ]);
  });
  it("removes a cap with null and prints metadata", async () => {
    const run = await cli(["update", id, "--remove-spend-cap"]);
    expect(run.code, run.stderr).toBe(0);
    expect(requests[0]?.body).toEqual({ monthlySpendCapDollars: null });
    for (const text of [id, "Shop assistant", "Monthly spend cap", "none"])
      expect(run.stdout).toContain(text);
  });
  it("renames without changing the cap", async () => {
    const run = await cli(["update", id, "--name", "Renamed", "--json"]);
    expect(run.code, run.stderr).toBe(0);
    expect(requests[0]?.body).toEqual({ name: "Renamed" });
  });
  it("previews the request without HTTP", async () => {
    const run = await cli(["update", id, "--monthly-spend-cap", "25", "--dry-run", "--json"]);
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout).data).toEqual({
      dryRun: true,
      action: "agents.update",
      agentId: id,
      request: { monthlySpendCapDollars: 25 },
    });
    expect(requests).toEqual([]);
    const human = await cli(["update", id, "--remove-spend-cap", "--dry-run"]);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain('"monthlySpendCapDollars":null');
    expect(requests).toEqual([]);
  });
  it.each([
    [],
    ["--monthly-spend-cap", "25", "--remove-spend-cap"],
    ["--name", ""],
    ["--monthly-spend-cap", "0"],
    ["--monthly-spend-cap", "1.001"],
    ["--monthly-spend-cap", "100001"],
    ["--monthly-spend-cap", "NaN"],
  ])("rejects invalid updates before a request: %j", async (...args) => {
    const run = await cli(["update", id, ...args, "--json"]);
    expect(run.code, run.stderr).toBe(2);
    expect(run.stderr).not.toBe("");
    expect(requests).toEqual([]);
  });
});

describe("agent draft replacement", () => {
  it("round-trips the draft read by get through a file", async () => {
    const read = await cli(["get", id, "--json"]);
    expect(read.code, read.stderr).toBe(0);
    const saved = JSON.parse(read.stdout).data;
    const file = join(home, "draft.json");
    await writeFile(file, JSON.stringify(saved.draft));
    requests = [];
    responseBody = { ...agent, revision: "revision-2" };
    const run = await cli([
      "draft",
      "replace",
      id,
      "--revision",
      saved.revision,
      "--file",
      file,
      "--json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      command: "agents.draft.replace",
      data: responseBody,
    });
    expect(requests).toEqual([
      {
        method: "PUT",
        path: `/v1/agents/${id}/draft`,
        body: { revision: "revision-1", definition: agent.draft },
      },
    ]);
  });
  it("accepts stdin and describes the unpublished draft", async () => {
    responseBody = { ...agent, revision: "revision-2" };
    const run = await cli(
      ["draft", "replace", id, "--revision", "revision-1", "--file", "-"],
      JSON.stringify(agent.draft),
    );
    expect(run.code, run.stderr).toBe(0);
    expect(requests).toEqual([
      {
        method: "PUT",
        path: `/v1/agents/${id}/draft`,
        body: { revision: "revision-1", definition: agent.draft },
      },
    ]);
    for (const text of [id, "revision-2", "unpublished", "samva agents publish"])
      expect(run.stdout).toContain(text);
  });
  it("previews a validated draft without HTTP", async () => {
    const run = await cli(
      ["draft", "replace", id, "--revision", "revision-1", "--file", "-", "--dry-run", "--json"],
      JSON.stringify(agent.draft),
    );
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout).data).toEqual({
      dryRun: true,
      action: "agents.draft.replace",
      agentId: id,
      request: { revision: "revision-1", definition: agent.draft },
    });
    expect(requests).toEqual([]);
  });
  it.each(["{broken", '{"instructions":123}'])("rejects invalid draft JSON: %s", async (source) => {
    const file = join(home, "invalid.json");
    await writeFile(file, source);
    const run = await cli([
      "draft",
      "replace",
      id,
      "--revision",
      "revision-1",
      "--file",
      file,
      "--json",
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("Invalid AgentDefinition JSON");
    expect(requests).toEqual([]);
  });
  it("requires a revision and a readable file", async () => {
    for (const flags of [
      ["--file", "-"],
      ["--revision", "revision-1", "--file", join(home, "missing.json")],
    ]) {
      const run = await cli(["draft", "replace", id, ...flags, "--json"]);
      expect(run.code, run.stderr).toBe(2);
    }
    expect(requests).toEqual([]);
  });
  it("preserves stale-revision conflicts with HTTP 409", async () => {
    status = 409;
    responseBody = {
      _tag: "ConflictError",
      message: "The agent changed. Read it again.",
      resource: "agent",
      id,
    };
    const run = await cli(
      ["draft", "replace", id, "--revision", "stale", "--file", "-", "--json"],
      JSON.stringify(agent.draft),
    );
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stderr)).toMatchObject({ reason: "ConflictError", status: 409 });
    expect(requests).toHaveLength(1);
  });
});

describe("agent publishing", () => {
  const published = {
    agent: { ...agent, publishedVersion: 1, publishedAt: agent.createdAt },
    version: {
      agentId: id,
      version: 1,
      definition: agent.draft,
      publishedAt: agent.createdAt,
      modelFallback: null,
    },
    published: true,
  };
  it("publishes the supplied revision without reading the agent", async () => {
    responseBody = published;
    const run = await cli(["publish", id, "--revision", "revision-1", "--json"]);
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ command: "agents.publish", data: published });
    expect(requests).toEqual([
      { method: "POST", path: `/v1/agents/${id}/publish`, body: { revision: "revision-1" } },
    ]);
  });
  it("reads the current revision when omitted, then publishes it", async () => {
    responseBody = published;
    getBody = { ...agent, revision: "current-revision" };
    const run = await cli(["publish", id]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("Published version 1");
    expect(requests).toEqual([
      { method: "GET", path: `/v1/agents/${id}`, body: undefined },
      { method: "POST", path: `/v1/agents/${id}/publish`, body: { revision: "current-revision" } },
    ]);
  });
  it("stops when the revision read fails", async () => {
    status = 500;
    getBody = { _tag: "InternalError", message: "Could not read the agent" };
    const run = await cli(["publish", id, "--json"]);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stderr)).toMatchObject({ command: "agents.publish", status: 500 });
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests)
      expect(request).toEqual({ method: "GET", path: `/v1/agents/${id}`, body: undefined });
  });
  it("surfaces publish conflicts without retrying a new revision", async () => {
    status = 409;
    responseBody = {
      _tag: "ConflictError",
      message: "The agent changed. Read it again.",
      resource: "agent",
      id,
    };
    const run = await cli(["publish", id, "--revision", "stale", "--json"]);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stderr)).toMatchObject({
      command: "agents.publish",
      reason: "ConflictError",
      status: 409,
    });
    expect(requests).toEqual([
      { method: "POST", path: `/v1/agents/${id}/publish`, body: { revision: "stale" } },
    ]);
  });
  it.each([true, false])("reports an unchanged draft (json=%s)", async (json) => {
    responseBody = { ...published, published: false };
    const run = await cli(["publish", id, "--revision", "revision-1", ...(json ? ["--json"] : [])]);
    expect(run.code, run.stderr).toBe(0);
    if (json) expect(JSON.parse(run.stdout).data).toEqual(responseBody);
    else expect(run.stdout).toContain("The draft matches version 1; nothing was published.");
  });
  it.each([[], ["--revision", "revision-1"]])(
    "previews without any requests: %j",
    async (...flags) => {
      const run = await cli(["publish", id, ...flags, "--dry-run", "--json"]);
      expect(run.code, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout).data).toMatchObject({
        dryRun: true,
        action: "agents.publish",
        agentId: id,
      });
      expect(requests).toEqual([]);
    },
  );
});
