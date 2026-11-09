import { mkdtemp, rm } from "node:fs/promises";
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
let requests: Array<{ method: string; path: string; body: unknown }> = [];
const server = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  requests.push({
    method: request.method!,
    path: request.url!,
    body: raw ? JSON.parse(raw) : undefined,
  });
  response.writeHead(201, { "content-type": "application/json" });
  response.end(JSON.stringify(agent));
});
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "samva-cli-agent-create-"));
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
});
const cli = (args: ReadonlyArray<string>) =>
  runCli(["agents", "create", draft.name, ...args], {
    configHome: home,
    env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "samva_sk_test_policies" },
  });

describe("agent creation", () => {
  it("sends the setup job and returns the created agent in clean JSON", async () => {
    const run = await cli(["--setup-job", "store", "--json"]);
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      type: "result",
      command: "agents.create",
      data: agent,
    });
    expect(requests).toEqual([{ method: "POST", path: "/v1/agents", body: draft }]);
  });
  it("previews the setup job without accessing the API", async () => {
    const run = await cli(["--setup-job", "booking", "--dry-run", "--json"]);
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      data: { dryRun: true, request: { name: draft.name, setupJob: "booking" } },
    });
    expect(requests).toEqual([]);
  });
  it("rejects a removed setup job before a request", async () => {
    const run = await cli(["--setup-job", "blank", "--json"]);
    expect(run.code).toBe(2);
    expect(requests).toEqual([]);
  });
});
