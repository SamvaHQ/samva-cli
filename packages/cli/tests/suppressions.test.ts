import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest";

import { runCli } from "./support/run-cli";

const namespaceId = "ns_1234567890123456";
const id = "supp_1234567890abcdef";
const entry = {
  id,
  namespaceId,
  email: "ada@example.com",
  type: "bounce",
  bounceType: "Permanent",
  bounceSubType: null,
  reason: "Mailbox unavailable",
  messageId: null,
  isActive: true,
  expiresAt: null,
  createdAt: "2026-11-01T00:00:00.000Z",
};
const requests: Array<{ method: string; path: string; body: unknown }> = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };
let pageReplies: Array<{ status: number; body: unknown }> = [];
let configHome = "";
let apiUrl = "";
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  requests.push({
    method: request.method!,
    path: request.url!,
    body: body ? JSON.parse(body) : undefined,
  });
  const current = pageReplies.shift() ?? reply;
  response.writeHead(current.status, { "content-type": "application/json" });
  response.end(JSON.stringify(current.body));
});
beforeAll(async () => {
  configHome = await mkdtemp(join(tmpdir(), "samva-suppressions-"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await rm(configHome, { recursive: true, force: true });
});
beforeEach(() => {
  requests.length = 0;
  pageReplies = [];
});
const run = (args: ReadonlyArray<string>, body: unknown, status = 200) => {
  reply = { status, body };
  return runCli(args, {
    configHome,
    env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "sk_test_namespace_reach" },
  });
};

describe("suppression commands", () => {
  it("forwards filters and retains the scope in human and machine output", async () => {
    const args = [
      "suppressions",
      "list",
      "--namespace",
      namespaceId,
      "--type",
      "bounce",
      "--status",
      "active",
      "--search",
      "ada",
    ];
    const body = { items: [entry], nextCursor: "next" };
    const machine = await run([...args, "--json"], body);
    expect(machine.code, machine.stderr).toBe(0);
    expect(JSON.parse(machine.stdout)).toMatchObject({ command: "suppressions.list", data: body });
    const url = new URL(requests[0]!.path, apiUrl);
    expect(url.pathname).toBe("/v1/email/suppressions");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      namespaceId,
      type: "bounce",
      status: "active",
      search: "ada",
    });
    const human = await run(args, body);
    expect(human.code, human.stderr).toBe(0);
    for (const value of [id, namespaceId, entry.email, entry.reason, "next"])
      expect(human.stdout).toContain(value);
  });

  it("does not invent a namespace and bounds traversal unless --all --jsonl is explicit", async () => {
    const result = await run(["suppressions", "list", "--json"], { items: [], nextCursor: "next" });
    expect(result.code, result.stderr).toBe(0);
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.path, apiUrl).searchParams.has("namespaceId")).toBe(false);
    requests.length = 0;
    const refused = await run(["suppressions", "list", "--all", "--json"], {});
    expect(refused.code).toBe(2);
    expect(requests).toEqual([]);
  });

  it("streams pages with the same namespace filter and follows the returned cursor", async () => {
    const second = { ...entry, id: "supp_2222222222222222", namespaceId };
    pageReplies = [
      { status: 200, body: { items: [entry], nextCursor: "next" } },
      { status: 200, body: { items: [second], nextCursor: null } },
    ];
    const result = await run(
      ["suppressions", "list", "--namespace", namespaceId, "--all", "--jsonl"],
      {},
    );
    expect(result.code, result.stderr).toBe(0);
    expect(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).data),
    ).toEqual([entry, second]);
    expect(requests).toHaveLength(2);
    for (const request of requests)
      expect(new URL(request.path, apiUrl).searchParams.get("namespaceId")).toBe(namespaceId);
    expect(new URL(requests[1]!.path, apiUrl).searchParams.get("cursor")).toBe("next");
  });

  it("previews removal and requires confirmation before a real write", async () => {
    const preview = await run(["suppressions", "remove", id, "--dry-run", "--json"], {});
    expect(preview.code, preview.stderr).toBe(0);
    expect(JSON.parse(preview.stdout).data).toEqual({
      dryRun: true,
      action: "suppressions.remove",
      request: { id },
    });
    const refused = await run(["suppressions", "remove", id, "--json"], {});
    expect(refused.code).toBe(2);
    expect(requests).toEqual([]);
    const removed = await run(["suppressions", "remove", id, "--yes", "--json"], {
      success: true,
      message: "Suppression removed",
    });
    expect(removed.code, removed.stderr).toBe(0);
    expect(requests).toEqual([
      { method: "DELETE", path: `/v1/email/suppressions/${id}`, body: undefined },
    ]);
  });

  it("preserves scope refusals without retrying", async () => {
    const result = await run(
      ["suppressions", "list", "--namespace", namespaceId, "--json"],
      { _tag: "ForbiddenError", message: "Namespace does not match key" },
      403,
    );
    expect(result.code).toBe(4);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(result.stderr).reason).toBe("ForbiddenError");
  });

  it("refuses malformed namespace and suppression ids before a request", async () => {
    for (const args of [
      ["suppressions", "list", "--namespace", "bad", "--json"],
      ["suppressions", "remove", "bad", "--yes", "--json"],
    ]) {
      const result = await run(args, {});
      expect(result.code).toBe(2);
    }
    expect(requests).toEqual([]);
  });
});
