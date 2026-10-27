import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest";

import { runCli } from "./support/run-cli";

const nsId = "ns_1234567890123456";
const otherNsId = "ns_6543210987654321";
const domainId = "dom_1234567890123456";
const date = "2026-10-17T00:00:00.000Z";
const namespace = {
  id: nsId,
  name: "Acme",
  createdAt: date,
  metadata: { customerId: "cus_123" },
  updatedAt: date,
};

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}
let apiUrl = "";
let home = "";
const requests: Array<Recorded> = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  requests.push({ method: req.method!, path: req.url!, body: raw ? JSON.parse(raw) : undefined });
  res.writeHead(reply.status, { "content-type": "application/json" });
  res.end(JSON.stringify(reply.body));
});
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "samva-namespaces-"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  apiUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.close();
  await rm(home, { recursive: true, force: true });
});
beforeEach(() => {
  requests.length = 0;
});

const run = (args: ReadonlyArray<string>, response: { status: number; body: unknown }) => {
  reply = response;
  return runCli(["namespaces", ...args], {
    configHome: home,
    env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "sk_test_namespaces" },
  });
};

describe("samva namespaces", () => {
  it("lists namespaces in human and JSON output", async () => {
    const page = {
      items: [{ id: nsId, name: "Acme", createdAt: date }],
      nextCursor: null,
    };
    const human = await run(["list"], { status: 200, body: page });
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain(nsId);
    expect(human.stdout).toContain("Acme");
    expect(requests[0]).toMatchObject({ method: "GET", path: "/v1/namespaces" });

    const json = await run(["list", "--json"], { status: 200, body: page });
    expect(json.code, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout).data.items[0].id).toBe(nsId);
  });

  it("creates a namespace with metadata labels", async () => {
    const result = await run(["create", "Acme", "--metadata", "customerId=cus_123", "--json"], {
      status: 201,
      body: namespace,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/namespaces",
      body: { name: "Acme", metadata: { customerId: "cus_123" } },
    });
    expect(JSON.parse(result.stdout).data.id).toBe(nsId);
  });

  it("refuses malformed metadata before any request", async () => {
    const result = await run(["create", "Acme", "--metadata", "nokey"], {
      status: 201,
      body: namespace,
    });
    expect(result.code).toBe(2);
    expect(requests).toEqual([]);
  });

  it("deletes a key through update and merges the rest", async () => {
    const result = await run(
      ["update", nsId, "--name", "Acme Inc", "--metadata", "plan=pro", "--unset-metadata", "old"],
      { status: 200, body: namespace },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(requests[0]).toMatchObject({
      method: "PATCH",
      path: `/v1/namespaces/${nsId}`,
      body: { name: "Acme Inc", metadata: { plan: "pro", old: null } },
    });
  });

  it("requires confirmation to delete outside a terminal", async () => {
    const result = await run(["delete", nsId], { status: 200, body: {} });
    expect(result.code).toBe(2);
    expect(requests).toEqual([]);
  });

  it("assigns exactly one resource", async () => {
    const moved = { type: "domain", id: domainId, namespaceId: nsId };
    const result = await run(["assign", nsId, "--domain", domainId, "--json"], {
      status: 200,
      body: moved,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: `/v1/namespaces/${nsId}/resources`,
      body: { type: "domain", resourceId: domainId },
    });
    expect(JSON.parse(result.stdout).data).toEqual(moved);
  });

  it.each([
    ["no resource flag", ["assign", nsId]],
    [
      "two resource flags",
      ["assign", nsId, "--domain", domainId, "--sender", "snd_1234567890123456"],
    ],
    ["unassign with none", ["unassign", nsId]],
  ])("rejects %s with a usage error", async (_name, args) => {
    const result = await run(args, { status: 200, body: {} });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("exactly one resource");
    expect(requests).toEqual([]);
  });

  it("returns a resource to organization level", async () => {
    const result = await run(["unassign", nsId, "--domain", domainId], {
      status: 200,
      body: { type: "domain", id: domainId, namespaceId: null },
    });
    expect(result.code, result.stderr).toBe(0);
    expect(requests[0]).toMatchObject({
      method: "DELETE",
      path: `/v1/namespaces/${nsId}/resources/domain/${domainId}`,
    });
    expect(result.stdout).toContain("organization");
  });

  it("reads usage for a window", async () => {
    const usage = {
      namespaceId: nsId,
      periodStart: date,
      periodEnd: "2026-10-18T00:00:00.000Z",
      emailCount: 12,
      totalMessages: 12,
    };
    const human = await run(["usage", nsId, "--after", date], { status: 200, body: usage });
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain("12");
    expect(new URL(requests[0]!.path, apiUrl).searchParams.get("after")).toBe(date);

    const json = await run(["usage", nsId, "--json"], { status: 200, body: usage });
    expect(JSON.parse(json.stdout).data.emailCount).toBe(12);
  });
});

describe("--namespace on resource commands", () => {
  it("filters domain lists and places a new domain", async () => {
    reply = { status: 200, body: { items: [], nextCursor: null } };
    const list = await runCli(["email", "domains", "list", "--namespace", otherNsId, "--json"], {
      configHome: home,
      env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "sk_test_namespaces" },
    });
    expect(list.code, list.stderr).toBe(0);
    expect(new URL(requests.at(-1)!.path, apiUrl).searchParams.get("namespaceId")).toBe(otherNsId);

    const add = await runCli(
      [
        "email",
        "domains",
        "add",
        "--domain",
        "acme.example",
        "--namespace",
        nsId,
        "--dry-run",
        "--json",
      ],
      { configHome: home, env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "sk_test_namespaces" } },
    );
    expect(add.code, add.stderr).toBe(0);
    expect(JSON.parse(add.stdout).data).toMatchObject({
      domain: "acme.example",
      namespaceId: nsId,
    });
  });

  it("rejects a namespace id that is not one", async () => {
    const result = await runCli(["contacts", "list", "--namespace", "nope"], {
      configHome: home,
      env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "sk_test_namespaces" },
    });
    expect(result.code).toBe(2);
  });
});
