import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest";

import { runCli } from "./support/run-cli";

const namespaceId = "ns_1234567890123456";
const payload = {
  email: "ada@example.com",
  role: "member",
  mailboxAddress: "ada@acme.example",
  namespaceId,
};
const requests: unknown[] = [];
let apiUrl = "";
let configHome = "";
let forbidden = false;
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  requests.push({ method: request.method, path: request.url, body: JSON.parse(body) });
  if (forbidden) {
    response.writeHead(403, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        _tag: "ForbiddenError",
        message: "Sign in as an unrestricted organization admin",
      }),
    );
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ id: "inv_1234567890123456", ...payload, status: "pending" }));
});
beforeAll(async () => {
  configHome = await mkdtemp(join(tmpdir(), "samva-org-invite-"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await rm(configHome, { recursive: true, force: true });
});
beforeEach(() => {
  requests.length = 0;
  forbidden = false;
});
const run = (args: string[]) =>
  runCli(["org", "invite", "ada@example.com", ...args], {
    configHome,
    env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "sk_test_invite" },
  });
const flags = ["--mailbox-address", payload.mailboxAddress, "--namespace", namespaceId];

describe("samva org invite", () => {
  it("sends the chosen namespace and personal address with the member role", async () => {
    const result = await run([...flags, "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(requests).toEqual([
      { method: "POST", path: "/v1/organizations/members/invitations", body: payload },
    ]);
    expect(JSON.parse(result.stdout).data.namespaceId).toBe(namespaceId);
  });

  it("preserves a permission denial as a machine-readable error", async () => {
    forbidden = true;
    const result = await run([...flags, "--json"]);
    expect(result.code).toBe(4);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ reason: "ForbiddenError", status: 403 });
  });

  it("previews without calling the API", async () => {
    const result = await run([...flags, "--dry-run", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(requests).toEqual([]);
    expect(JSON.parse(result.stdout).data).toEqual({ dryRun: true, ...payload });
  });

  it("rejects a malformed namespace and an owner invitation before sending", async () => {
    for (const args of [
      ["--mailbox-address", payload.mailboxAddress, "--namespace", "invalid"],
      [...flags, "--role", "owner"],
    ]) {
      const result = await run(args);
      expect(result.code).toBe(2);
    }
    expect(requests).toEqual([]);
  });
});
