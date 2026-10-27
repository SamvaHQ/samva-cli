import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest";

import { runCli } from "./support/run-cli";

// Process-level contract for `samva api-keys`: what reaches the wire, what reaches stdout and
// stderr, and the exit code. The server records requests and answers from `reply`.

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

const secret = "samva_sk_live_created_once";
const keyId = "key_1234567890abcdef";
const key = {
  id: keyId,
  name: "ci",
  start: "samva_sk_",
  end: "_test",
  description: "CI sender",
  createdAt: "2026-07-01T00:00:00.000Z",
  expiresAt: null,
  lastUsedAt: null,
  isActive: true,
  access: { mode: "restricted", resources: { email: "write" } },
  owner: { id: "user_1", name: "Ada Lovelace", email: "ada@example.com" },
};

let requests: Array<Recorded> = [];
let reply: (request: Recorded) => unknown = () => ({});
let server: Server;
let apiUrl = "";
let home = "";

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "samva-api-keys-"));
  server = createServer((req, res) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      const recorded: Recorded = {
        method: req.method ?? "",
        url: req.url ?? "",
        body: raw === "" ? null : JSON.parse(raw),
      };
      requests.push(recorded);
      res.writeHead(recorded.method === "POST" && recorded.url === "/v1/api-keys" ? 201 : 200, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify(reply(recorded)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP port");
  apiUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  reply = () => ({});
});

const cli = (args: ReadonlyArray<string>) =>
  runCli(["api-keys", ...args], {
    configHome: home,
    env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "samva_sk_test_caller" },
  });

const data = (stdout: string) => {
  const envelope = JSON.parse(stdout) as { type: string; data: Record<string, unknown> };
  expect(envelope.type).toBe("result");
  return envelope.data;
};

describe("samva api-keys create", () => {
  it.each([
    ["neither", ["--name", "ci"]],
    ["both", ["--name", "ci", "--full-access", "--grant", "email=write"]],
  ])("refuses %s of --grant and --full-access before any request", async (_label, args) => {
    const result = await cli(["create", ...args, "--json"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "error" });
    expect(result.stderr).toContain("--full-access");
    expect(result.stderr).toContain("--grant");
    expect(requests).toEqual([]);
  });

  it.each([
    ["no level", "email", "<resource>=read|write"],
    ["an unknown resource", "bogus=read", "Resources:"],
    ["a read-only resource at write", "analytics=write", "can only be granted read"],
    ["mailboxes", "mailboxes=read", "--mailbox-permission"],
    ["a repeated resource", "email=read", "more than once"],
  ])("refuses a malformed grant (%s)", async (_label, grant, hint) => {
    const grants = grant === "email=read" ? ["email=write", grant] : [grant];
    const result = await cli([
      "create",
      "--name",
      "ci",
      ...grants.flatMap((value) => ["--grant", value]),
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(hint);
    expect(requests).toEqual([]);
  });

  it("refuses a name the API schema refuses and an unparsable expiry", async () => {
    const tooLong = await cli(["create", "--name", "x".repeat(33), "--full-access"]);
    expect(tooLong.code).toBe(2);
    expect(requests).toEqual([]);
    const expiry = await cli(["create", "--name", "ci", "--full-access", "--expires-at", "soon"]);
    expect(expiry.code).toBe(2);
    expect(expiry.stderr).toContain("ISO 8601");
    expect(requests).toEqual([]);
  });

  it("previews the request with --dry-run and sends nothing", async () => {
    const json = await cli([
      "create",
      "--name",
      "ci",
      "--grant",
      "email=write",
      "--grant",
      "contacts=read",
      "--expires-at",
      "2027-01-01T00:00:00Z",
      "--dry-run",
      "--json",
    ]);
    expect(json.code, json.stderr).toBe(0);
    expect(data(json.stdout)).toEqual({
      dryRun: true,
      action: "api-keys.create",
      request: {
        name: "ci",
        expiresAt: "2027-01-01T00:00:00Z",
        access: { mode: "restricted", resources: { email: "write", contacts: "read" } },
      },
    });
    const human = await cli(["create", "--name", "ci", "--full-access", "--dry-run"]);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toMatch(/^Action\s+api-keys\.create$/m);
    expect(human.stdout).toMatch(/^Access\s+full$/m);
    expect(human.stdout).not.toContain("{");
    expect(requests).toEqual([]);
  });

  it("sends the flags as the create payload", async () => {
    reply = () => ({ ...key, key: secret });
    const result = await cli([
      "create",
      "--name",
      "ci",
      "--description",
      "CI sender",
      "--grant",
      "email=write",
      "--json",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(requests).toEqual([
      {
        method: "POST",
        url: "/v1/api-keys",
        body: {
          name: "ci",
          description: "CI sender",
          access: { mode: "restricted", resources: { email: "write" } },
        },
      },
    ]);
  });

  it("returns the shown-once key in the JSON contract so it pipes to jq", async () => {
    reply = () => ({ ...key, key: secret });
    const result = await cli(["create", "--name", "ci", "--grant", "email=write", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("<redacted>");
    const output = data(result.stdout);
    expect(output.key).toBe(secret);
    expect(output.displayOnce).toBe(true);
    expect(output.warning).toEqual(expect.stringContaining("shown once"));
    expect(output.apiKey).toMatchObject({ id: keyId, name: "ci" });
    expect(output.apiKey).not.toHaveProperty("key");
  });

  it("prints the key in human output with the warning on stderr", async () => {
    reply = () => ({ ...key, key: secret });
    const result = await cli(["create", "--name", "ci", "--grant", "email=write"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`^API key\\s+${secret}$`, "m"));
    expect(result.stdout).toMatch(/^Access\s+restricted \(email:write\)$/m);
    expect(result.stdout).not.toContain("<redacted>");
    expect(result.stderr).toContain("WARNING: This API key is shown once.");
  });
});

describe("samva api-keys create grants", () => {
  it("accepts every resource its help offers and refuses the ones the public API omits", async () => {
    const help = await cli(["create", "--help"]);
    expect(help.code, help.stderr).toBe(0);
    const offered = /Resources: ([^\n]+)/.exec(help.stdout)?.[1]?.trim().split(", ");
    expect(offered).toBeDefined();
    expect(offered).toContain("email");
    expect(offered).not.toContain("sms");

    for (const resource of offered ?? []) {
      const result = await cli([
        "create",
        "--name",
        "ci",
        "--grant",
        `${resource}=read`,
        "--dry-run",
      ]);
      expect(result.code, `${resource}: ${result.stderr}`).toBe(0);
    }

    for (const gated of ["sms", "whatsapp", "whatsappAccounts"]) {
      const result = await cli(["create", "--name", "ci", "--grant", `${gated}=read`, "--dry-run"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Resources:");
      expect(result.stderr).toContain("email");
      expect(result.stderr).not.toMatch(new RegExp(`Resources:.*\\b${gated}\\b`));
    }
    expect(requests).toEqual([]);
  });
});

describe("samva api-keys create mailbox access", () => {
  const mailboxId = "mbx_1234567890123456";
  const otherMailboxId = "mbx_6543210987654321";
  const namespaceId = "ns_1234567890123456";

  it("sends mailbox permissions, mailboxes, send mode, and namespace as the access", async () => {
    const result = await cli([
      "create",
      "--name",
      "agent",
      "--mailbox-permission",
      "read",
      "--mailbox-permission",
      "send",
      "--mailbox",
      mailboxId,
      "--mailbox",
      otherMailboxId,
      "--send-mode",
      "approval",
      "--dry-run",
      "--json",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(data(result.stdout)).toEqual({
      dryRun: true,
      action: "api-keys.create",
      request: {
        name: "agent",
        access: {
          mode: "restricted",
          resources: {},
          mailboxes: {
            permissions: ["read", "send"],
            mailboxIds: [mailboxId, otherMailboxId],
            sendMode: "approval",
          },
        },
      },
    });
    expect(requests).toEqual([]);
  });

  it("combines resource grants with mailbox access and a namespace", async () => {
    reply = () => ({ ...key, key: secret });
    const result = await cli([
      "create",
      "--name",
      "agent",
      "--grant",
      "email=read",
      "--mailbox-permission",
      "read",
      "--namespace",
      namespaceId,
      "--json",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(requests).toEqual([
      {
        method: "POST",
        url: "/v1/api-keys",
        body: {
          name: "agent",
          access: {
            mode: "restricted",
            resources: { email: "read" },
            mailboxes: { permissions: ["read"] },
            namespaceId,
          },
        },
      },
    ]);
  });

  it("describes mailbox access in human output", async () => {
    const result = await cli([
      "create",
      "--name",
      "agent",
      "--mailbox-permission",
      "send",
      "--mailbox",
      mailboxId,
      "--send-mode",
      "approval",
      "--dry-run",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(
      new RegExp(
        `^Access\\s+restricted \\(mailboxes:send \\[${mailboxId}; approval sends\\]\\)$`,
        "m",
      ),
    );
  });

  it.each([
    [
      "--mailbox without a permission",
      ["--grant", "email=read", "--mailbox", mailboxId],
      "--mailbox-permission",
    ],
    [
      "--send-mode without a permission",
      ["--grant", "email=read", "--send-mode", "approval"],
      "--mailbox-permission",
    ],
    [
      "a repeated permission",
      ["--mailbox-permission", "read", "--mailbox-permission", "read"],
      "more than once",
    ],
    [
      "a repeated mailbox",
      ["--mailbox-permission", "read", "--mailbox", mailboxId, "--mailbox", mailboxId],
      "more than once",
    ],
    [
      "--full-access with mailbox access",
      ["--full-access", "--mailbox-permission", "read"],
      "--full-access",
    ],
    [
      "--full-access with a namespace",
      ["--full-access", "--namespace", namespaceId],
      "--full-access",
    ],
    ["a namespace alone", ["--namespace", namespaceId], "Choose the key's access"],
    ["an unknown permission", ["--mailbox-permission", "delete"], "mailbox-permission"],
    ["a malformed mailbox id", ["--mailbox-permission", "read", "--mailbox", "nope"], "mailbox"],
  ])("refuses %s before any request", async (_label, flags, hint) => {
    const result = await cli(["create", "--name", "agent", ...flags]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(hint);
    expect(requests).toEqual([]);
  });
});

describe("samva api-keys rotate and revoke", () => {
  it.each(["rotate", "revoke"])("%s requires --yes outside a terminal", async (command) => {
    const result = await cli([command, keyId, "--json"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--yes");
    expect(requests).toEqual([]);
  });

  it.each(["rotate", "revoke"])("%s --dry-run sends nothing", async (command) => {
    const result = await cli([command, keyId, "--dry-run", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(data(result.stdout)).toEqual({ dryRun: true, action: `api-keys.${command}`, id: keyId });
    expect(requests).toEqual([]);
  });

  it("rotates and returns the new key once", async () => {
    reply = () => ({ ...key, key: "samva_sk_live_rotated" });
    const json = await cli(["rotate", keyId, "--yes", "--json"]);
    expect(json.code, json.stderr).toBe(0);
    expect(requests).toEqual([{ method: "POST", url: `/v1/api-keys/${keyId}/rotate`, body: null }]);
    expect(data(json.stdout)).toMatchObject({ key: "samva_sk_live_rotated", displayOnce: true });

    const human = await cli(["rotate", keyId, "--yes"]);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toMatch(/^API key\s+samva_sk_live_rotated$/m);
    expect(human.stderr).toContain("WARNING: This API key is shown once.");
  });

  it("revokes", async () => {
    reply = () => ({ success: true });
    const result = await cli(["revoke", keyId, "--yes"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Revoked API key ${keyId}.`);
    expect(requests).toEqual([{ method: "POST", url: `/v1/api-keys/${keyId}/revoke`, body: null }]);
  });
});

describe("samva api-keys list, get, and update", () => {
  it("lists with filters as formatted fields, never raw JSON", async () => {
    reply = () => ({ items: [key], nextCursor: "cur_2" });
    const result = await cli(["list", "--status", "active", "--search", "ci", "--limit", "5"]);
    expect(result.code, result.stderr).toBe(0);
    const url = new URL(requests[0]?.url ?? "", "http://localhost");
    expect(url.pathname).toBe("/v1/api-keys");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: "active",
      search: "ci",
      limit: "5",
    });
    expect(result.stdout).toMatch(/^ID\s+key_1234567890abcdef$/m);
    expect(result.stdout).toMatch(/^Status\s+active$/m);
    expect(result.stdout).toMatch(/^Next cursor\s+cur_2$/m);
    expect(result.stdout).not.toContain('"items"');
  });

  it("refuses --all without --jsonl and follows cursors with it", async () => {
    const refused = await cli(["list", "--all"]);
    expect(refused.code).toBe(2);
    expect(requests).toEqual([]);

    reply = (request) =>
      request.url.includes("cursor=cur_2")
        ? { items: [{ ...key, id: "key_second" }], nextCursor: null }
        : { items: [key], nextCursor: "cur_2" };
    const result = await runCli(["api-keys", "list", "--all", "--jsonl"], {
      configHome: home,
      env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "samva_sk_test_caller" },
    });
    expect(result.code, result.stderr).toBe(0);
    const ids = result.stdout
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { data: { id: string } }).data.id);
    expect(ids).toEqual([keyId, "key_second"]);
  });

  it("gets one key without a secret", async () => {
    reply = () => key;
    const result = await cli(["get", keyId, "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(requests).toEqual([{ method: "GET", url: `/v1/api-keys/${keyId}`, body: null }]);
    expect(data(result.stdout)).toMatchObject({ id: keyId, name: "ci" });
  });

  it("updates a name and description, and requires one", async () => {
    const none = await cli(["update", keyId]);
    expect(none.code).toBe(2);
    expect(requests).toEqual([]);

    reply = () => ({ ...key, name: "ci-prod" });
    const result = await cli(["update", keyId, "--name", "ci-prod", "--description", "Prod"]);
    expect(result.code, result.stderr).toBe(0);
    expect(requests).toEqual([
      {
        method: "PATCH",
        url: `/v1/api-keys/${keyId}`,
        body: { name: "ci-prod", description: "Prod" },
      },
    ]);
    expect(result.stdout).toMatch(/^Name\s+ci-prod$/m);
  });

  it("changes a mailbox key's send mode", async () => {
    reply = () => key;
    const dryRun = await cli(["update", keyId, "--send-mode", "approval", "--dry-run", "--json"]);
    expect(dryRun.code, dryRun.stderr).toBe(0);
    expect(data(dryRun.stdout)).toEqual({
      dryRun: true,
      action: "api-keys.update",
      id: keyId,
      request: { mailboxes: { sendMode: "approval" } },
    });
    expect(requests).toEqual([]);

    const result = await cli(["update", keyId, "--send-mode", "send"]);
    expect(result.code, result.stderr).toBe(0);
    expect(requests).toEqual([
      { method: "PATCH", url: `/v1/api-keys/${keyId}`, body: { mailboxes: { sendMode: "send" } } },
    ]);
  });

  it("says what update can change", async () => {
    const help = await cli(["update", "--help"]);
    expect(help.code, help.stderr).toBe(0);
    expect(help.stdout).toContain("--send-mode");
    expect(help.stdout).not.toContain("Access is fixed at creation");
  });
});
