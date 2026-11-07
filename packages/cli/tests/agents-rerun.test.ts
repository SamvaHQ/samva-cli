import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest";
import { DEFAULT_AGENT_DEFINITION } from "@samva/core/agents/definition";

import { runCli } from "./support/run-cli";

const id = "agt_1234567890123456";
const draft = { name: "Desk", definition: DEFAULT_AGENT_DEFINITION };
const result = {
  items: [
    {
      testId: "agttest_1234567890123456",
      publishedDecisions: [],
      draftDecisions: [{ actionIndex: 0, kind: "reply", outcome: "hold" }],
      changedDecisions: [{ actionIndex: 0, kind: "reply", outcome: "hold" }],
    },
  ],
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
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(result));
});
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "samva-cli-agent-rerun-"));
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
  runCli(["agents", "tests", "rerun", id, ...args], {
    configHome: home,
    env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "samva_sk_test_policies" },
  });

describe("agent saved-test rerun", () => {
  it("sends a validated draft and returns decisions in JSON", async () => {
    const run = await cli(["--data", JSON.stringify(draft), "--json"]);
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      type: "result",
      command: "agents.tests.rerun",
      data: result,
    });
    expect(requests).toEqual([
      { method: "POST", path: `/v1/agents/${id}/tests/rerun`, body: draft },
    ]);
  });
  it("previews without accessing the API", async () => {
    const run = await cli(["--data", JSON.stringify(draft), "--dry-run", "--json"]);
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ data: { dryRun: true, request: draft } });
    expect(requests).toEqual([]);
  });
  it("rejects malformed draft input before a request", async () => {
    const run = await cli(["--data", "{}", "--json"]);
    expect(run.code).toBe(2);
    expect(requests).toEqual([]);
  });
});
