import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";

import { runCli } from "./support/run-cli";

// Never called: puts the spawned entry in this file's import graph for `vitest --changed`.
void (() => import("./oauth-runner.ts"));

const runner = fileURLToPath(new URL("./oauth-runner.ts", import.meta.url));
const id = "exti_1234567890123456";
const mailboxId = "mbx_1234567890123456";
const date = "2026-10-06T00:00:00.000Z";
const manifest = {
  name: "auto-reply",
  displayName: "Auto reply",
  version: "1.0.0",
  runtime: "hosted",
  events: ["mailbox.message.received"],
  permissions: ["read", "send"],
};
const versionRef = { id: "extver_1234567890123456", version: "1.0.0" };
const extension = {
  id: "ext_1234567890123456",
  name: manifest.name,
  displayName: manifest.displayName,
  description: null,
  runtime: "hosted",
  latestVersion: versionRef,
  createdAt: date,
  updatedAt: date,
};
const versionSummary = {
  ...versionRef,
  runtime: "hosted",
  bundle: { sha256: "abc", sizeBytes: 42 },
  publishedAt: date,
};
const version = { ...versionSummary, manifest };
const installationSummary = {
  id,
  extensionId: extension.id,
  name: manifest.name,
  displayName: manifest.displayName,
  version: versionRef,
  runtime: "hosted",
  status: "active",
  createdAt: date,
};
const installation = {
  ...installationSummary,
  events: manifest.events,
  permissions: manifest.permissions,
  sendMode: "send",
  scope: { mailboxIds: null, namespaceId: null },
  webhook: null,
  updatedAt: date,
  disabledAt: null,
};
const installResponse = { installation, credentials: null };
const targetVersion = { id: "extver_2234567890123456", version: "2.0.0" };
const upgradePreview = {
  installation,
  fromVersion: versionRef,
  toVersion: targetVersion,
  permissionDiff: {
    added: ["permission:update", "event:mailbox.message.sent"],
    removed: ["permission:send"],
  },
  dryRun: true,
  versionChange: null,
};

const hostedRunSummary = {
  id: "run_test",
  eventId: "evt_test",
  eventType: "mailbox.message.received",
  attempt: 1,
  startedAt: date,
  durationMs: 13,
  outcome: "succeeded",
  error: null,
};
const hostedRun = { ...hostedRunSummary, logs: ["Replied"] };
const page = <Item>(items: Item[], nextCursor: string | null = null) => ({ items, nextCursor });
const scenarios = [
  {
    args: ["list"],
    response: page([extension]),
    method: "GET",
    path: "/v1/extensions",
    human: "auto-reply",
    status: 200,
  },
  {
    args: ["versions", "auto-reply"],
    response: page([versionSummary]),
    method: "GET",
    path: "/v1/extensions/auto-reply/versions",
    human: "1.0.0",
    status: 200,
  },
  {
    args: ["version", "auto-reply", "1.0.0"],
    response: version,
    method: "GET",
    path: "/v1/extensions/auto-reply/versions/1.0.0",
    human: "mailbox.message.received",
    status: 200,
  },
  {
    args: ["install", "auto-reply"],
    response: installResponse,
    method: "POST",
    path: "/v1/extension-installations",
    human: id,
    status: 201,
  },
  {
    args: ["installations"],
    response: page([installationSummary]),
    method: "GET",
    path: "/v1/extension-installations",
    human: id,
    status: 200,
  },
  {
    args: ["installation", id],
    response: installation,
    method: "GET",
    path: `/v1/extension-installations/${id}`,
    human: "read, send",
    status: 200,
  },
  {
    args: ["uninstall", id, "--yes"],
    response: { success: true },
    method: "DELETE",
    path: `/v1/extension-installations/${id}`,
    human: "Uninstalled",
    status: 200,
  },
  {
    args: ["disable", id],
    response: { ...installation, status: "disabled", disabledAt: date },
    method: "POST",
    path: `/v1/extension-installations/${id}/disable`,
    human: "disabled",
    status: 200,
  },
  {
    args: ["enable", id],
    response: installation,
    method: "POST",
    path: `/v1/extension-installations/${id}/enable`,
    human: "active",
    status: 200,
  },
  {
    args: ["runs", id],
    response: { items: [hostedRunSummary] },
    method: "GET",
    path: `/v1/extension-installations/${id}/runs`,
    human: "succeeded",
    status: 200,
  },
  {
    args: ["run", id, "run_test"],
    response: hostedRun,
    method: "GET",
    path: `/v1/extension-installations/${id}/runs/run_test`,
    human: "Replied",
    status: 200,
  },
];
interface RequestRecord {
  method: string;
  path: string;
  headers: import("node:http").IncomingHttpHeaders;
  body: unknown;
}
let requests: RequestRecord[] = [];
let response: { status: number; body?: unknown };
let home: string;
let apiUrl: string;
const projects: Record<string, string> = {};
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  requests.push({
    method: req.method!,
    path: req.url!,
    headers: req.headers,
    body: raw ? JSON.parse(raw) : undefined,
  });
  res.writeHead(response.status, { "content-type": "application/json" });
  res.end(response.body === undefined ? "" : JSON.stringify(response.body));
});
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "samva-extensions-"));
  await mkdir(join(home, "samva"));
  await writeFile(
    join(home, "samva", "config.json"),
    JSON.stringify({
      version: 2,
      profiles: { default: { credentialIdentity: "oauth", orgSlug: "acme" } },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP port");
  apiUrl = `http://127.0.0.1:${address.port}`;
  for (const runtime of ["hosted", "webhook"]) {
    const directory = join(home, runtime);
    const result = await runCli(
      [
        "--no-env-file",
        runner,
        "extensions",
        "init",
        directory,
        "--name",
        "auto-reply",
        "--runtime",
        runtime,
        "--json",
      ],
      { executable: "bun", configHome: home },
    );
    if (result.code !== 0) throw new Error(result.stderr);
    await symlink(
      fileURLToPath(new URL("../node_modules", import.meta.url)),
      join(directory, "node_modules"),
      "dir",
    );
    projects[runtime] = directory;
  }
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(home, { recursive: true });
});
const run = async (args: string[], body: unknown, status = 200, oauth = true) => {
  requests = [];
  response = { status, body };
  return runCli(["--no-env-file", runner, "extensions", ...args], {
    executable: "bun",
    configHome: home,
    env: { SAMVA_API_URL: apiUrl, ...(oauth ? {} : { SAMVA_API_KEY: "sk_test_extension" }) },
  });
};
const assertRequest = (method: string, path: string, oauth = true) => {
  expect(requests).toHaveLength(1);
  expect(requests[0]?.method).toBe(method);
  expect(requests[0]?.path).toBe(path);
  expect(requests[0]?.headers["x-samva-client"]).toMatch(/^cli\//);
  expect(requests[0]?.headers.authorization).toBe(oauth ? "Bearer oauth-test-token" : undefined);
  expect(requests[0]?.headers["x-org-slug"]).toBe(oauth ? "acme" : undefined);
  expect(requests[0]?.headers["x-api-key"]).toBe(oauth ? undefined : "sk_test_extension");
};
describe("extension API command contracts", () => {
  for (const runtime of ["hosted", "webhook"]) {
    for (const json of [false, true])
      it(`publishes ${runtime} manifest with ${json ? "JSON" : "human output"}`, async () => {
        const publishedManifest = {
          ...manifest,
          runtime,
          version: "0.1.0",
          displayName: "auto-reply",
        };
        const data = {
          extension: { ...extension, runtime },
          version: {
            ...version,
            version: "0.1.0",
            manifest: publishedManifest,
            bundle: runtime === "hosted" ? version.bundle : null,
          },
        };
        const result = await run(
          ["publish", projects[runtime]!, ...(json ? ["--json"] : [])],
          data,
          201,
        );
        expect(result.code, result.stderr).toBe(0);
        assertRequest("POST", "/v1/extensions");
        const payload = requests[0]?.body as { manifest: unknown; bundle?: string };
        expect(payload.manifest).toEqual(publishedManifest);
        if (runtime === "hosted") {
          expect(payload.bundle).toContain("auto-reply");
          expect(payload.bundle).toContain("export");
        } else expect(payload.bundle).toBeUndefined();
        if (json) expect(JSON.parse(result.stdout)).toEqual(data);
        else {
          expect(result.stdout).toContain("Published auto-reply@0.1.0");
          for (const value of [
            extension.id,
            extension.displayName,
            version.id,
            date,
            "mailbox.message.received",
            "read, send",
            ...(runtime === "hosted" ? ["abc", "42 bytes"] : ["None"]),
          ])
            expect(result.stdout).toContain(value);
        }
        expect(result.stderr).toBe("");
      });
  }
  for (const status of [403, 409])
    it(`maps publish ${status}`, async () => {
      const error =
        status === 403
          ? { _tag: "ForbiddenError", message: "API keys refused" }
          : { _tag: "ConflictError", message: "Different bundle", resource: "extension" };
      const result = await run(["publish", projects.hosted!, "--json"], error, status, false);
      expect(result.code).toBe(status === 403 ? 4 : 1);
      assertRequest("POST", "/v1/extensions", false);
      expect(result.stderr).toContain(status === 403 ? "samva login" : "Different bundle");
      expect(result.stdout).toBe("");
    });

  for (const scenario of scenarios) {
    for (const json of [false, true])
      it(`${scenario.args.join(" ")} renders ${json ? "JSON" : "human output"}`, async () => {
        const result = await run(
          [...scenario.args, ...(json ? ["--json"] : [])],
          scenario.response,
          scenario.status,
        );
        expect(result.code, result.stderr).toBe(0);
        expect(result.stderr).toBe("");
        assertRequest(scenario.method, scenario.path);
        if (json) expect(JSON.parse(result.stdout)).toEqual(scenario.response);
        else expect(result.stdout).toContain(scenario.human);
        if (scenario.method === "POST" && scenario.args[0] === "install")
          expect(requests[0]?.body).toEqual({ extension: "auto-reply" });
        else expect(requests[0]?.body).toBeUndefined();
      });
  }
  for (const json of [false, true])
    it(`previews upgrade authoritatively with ${json ? "JSON" : "human output"}`, async () => {
      const result = await run(
        ["upgrade", id, "--dry-run", ...(json ? ["--json"] : [])],
        upgradePreview,
      );
      expect(result.code, result.stderr).toBe(0);
      assertRequest("POST", `/v1/extension-installations/${id}/upgrade`);
      expect(requests[0]?.body).toEqual({ dryRun: true });
      expect(result.stderr).toBe("");
      if (json) expect(JSON.parse(result.stdout)).toEqual(upgradePreview);
      else {
        for (const fact of [
          "no changes made",
          "current state",
          versionRef.version,
          versionRef.id,
          targetVersion.version,
          targetVersion.id,
          ...upgradePreview.permissionDiff.added,
          ...upgradePreview.permissionDiff.removed,
          installation.status,
          "All accessible mailboxes",
          "All namespaces",
          "read, send",
        ])
          expect(result.stdout).toContain(fact);
      }
    });
  for (const selectedVersion of ["2.0.0", targetVersion.id])
    it(`forwards upgrade version ${selectedVersion} and exact grant acknowledgements`, async () => {
      const result = await run(
        [
          "upgrade",
          id,
          "--version",
          selectedVersion,
          "--accept-permissions",
          "permission:update",
          "--accept-permissions",
          "event:mailbox.message.sent",
          "--dry-run",
          "--json",
        ],
        upgradePreview,
      );
      expect(result.code, result.stderr).toBe(0);
      assertRequest("POST", `/v1/extension-installations/${id}/upgrade`);
      expect(requests[0]?.body).toEqual({
        version: selectedVersion,
        acceptPermissions: upgradePreview.permissionDiff.added,
        dryRun: true,
      });
    });
  for (const json of [false, true])
    it(`requires upgrade confirmation in ${json ? "JSON" : "human mode"}`, async () => {
      const result = await run(["upgrade", id, ...(json ? ["--json"] : [])], upgradePreview);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("--yes");
      expect(requests).toHaveLength(0);
      expect(result.stdout).toBe("");
    });
  it("applies with --yes without inventing grant acknowledgements or a local preview", async () => {
    const data = {
      ...upgradePreview,
      fromVersion: versionRef,
      toVersion: versionRef,
      permissionDiff: { added: [], removed: [] },
      dryRun: false,
    };
    const result = await run(["upgrade", id, "--yes", "--json"], data);
    expect(result.code, result.stderr).toBe(0);
    assertRequest("POST", `/v1/extension-installations/${id}/upgrade`);
    expect(requests[0]?.body).toEqual({});
    expect(JSON.parse(result.stdout)).toEqual(data);
    const human = await run(["upgrade", id, "--yes"], data);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain("already uses the selected version");
    expect(human.stdout).toMatch(/Added grants\s+None/);
    expect(human.stdout).toMatch(/Removed grants\s+None/);
  });
  for (const json of [false, true])
    it(`renders an applied upgrade and audit in ${json ? "JSON" : "human output"}`, async () => {
      const audit = {
        id: "extvc_test",
        organizationId: "org_1234567890123456",
        installationId: id,
        extensionId: extension.id,
        fromVersion: versionRef,
        toVersion: targetVersion,
        permissionDiff: upgradePreview.permissionDiff,
        changedBy: "user_1234567890123456",
        changedAt: date,
      };
      const data = {
        ...upgradePreview,
        installation: {
          ...installation,
          version: targetVersion,
          permissions: ["read", "update"],
          events: ["mailbox.message.received", "mailbox.message.sent"],
          scope: { mailboxIds: [mailboxId], namespaceId: "ns_1234567890123456" },
        },
        dryRun: false,
        versionChange: audit,
      };
      const result = await run(
        [
          "upgrade",
          id,
          "--yes",
          "--accept-permissions",
          "permission:update",
          "--accept-permissions",
          "event:mailbox.message.sent",
          ...(json ? ["--json"] : []),
        ],
        data,
      );
      expect(result.code, result.stderr).toBe(0);
      assertRequest("POST", `/v1/extension-installations/${id}/upgrade`);
      expect(requests[0]?.body).toEqual({ acceptPermissions: upgradePreview.permissionDiff.added });
      expect(result.stderr).toBe("");
      if (json) expect(JSON.parse(result.stdout)).toEqual(data);
      else
        for (const fact of [
          "Installation upgraded",
          audit.id,
          audit.organizationId,
          audit.changedBy,
          date,
          versionRef.id,
          targetVersion.id,
          "read, update",
          "active",
          mailboxId,
          data.installation.scope.namespaceId,
          ...upgradePreview.permissionDiff.added,
          ...upgradePreview.permissionDiff.removed,
        ])
          expect(result.stdout).toContain(fact);
    });
  for (const args of [
    ["--version", "garbage"],
    ["--accept-permissions", "send"],
  ])
    it(`rejects malformed upgrade inputs: ${args.join(" ")}`, async () => {
      const result = await run(["upgrade", id, "--dry-run", ...args, "--json"], upgradePreview);
      expect(result.code).toBe(2);
      expect(requests).toHaveLength(0);
    });
  it("preserves an API grant acknowledgement refusal", async () => {
    const error = {
      _tag: "ValidationError",
      message: "Acknowledge the exact added grants",
      fields: { acceptPermissions: ["permission:update", "event:mailbox.message.sent"] },
    };
    const result = await run(["upgrade", id, "--yes", "--json"], error, 422);
    expect(result.code).toBe(1);
    assertRequest("POST", `/v1/extension-installations/${id}/upgrade`);
    expect(requests[0]?.body).toEqual({});
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(error.message);
    expect(result.stderr).toContain("permission:update");
  });
  it("passes --limit and --cursor through and prints the next cursor", async () => {
    const cursor = Buffer.from(
      JSON.stringify({ at: "2026-10-06T00:00:00.000000Z", id: extension.id }),
    ).toString("base64url");
    const result = await run(
      ["list", "--limit", "1", "--cursor", cursor],
      page([extension], cursor),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(requests[0]?.path).toBe(`/v1/extensions?limit=1&cursor=${cursor}`);
    expect(result.stdout).toContain(`Next cursor`);
    expect(result.stdout).toContain(cursor);
  });
  it("shows extension identity, description, version reference and observation times", async () => {
    const data = {
      ...extension,
      description: "Answers received messages",
      updatedAt: "2026-10-07T01:02:03.000Z",
    };
    const result = await run(["list"], page([data]));
    expect(result.code, result.stderr).toBe(0);
    for (const value of [
      data.id,
      data.name,
      data.displayName,
      data.description,
      data.runtime,
      data.latestVersion.id,
      data.latestVersion.version,
      data.createdAt,
      data.updatedAt,
    ])
      expect(result.stdout).toContain(value);
  });
  it("shows the published manifest identity and description alongside bundle facts", async () => {
    const data = {
      ...version,
      manifest: { ...manifest, description: "Acknowledges received mail" },
    };
    const result = await run(["version", "auto-reply", "1.0.0"], data);
    expect(result.code, result.stderr).toBe(0);
    for (const value of [
      data.id,
      data.version,
      data.runtime,
      date,
      "42 bytes",
      "abc",
      manifest.name,
      manifest.displayName,
      data.manifest.description,
      "mailbox.message.received",
      "read, send",
    ])
      expect(result.stdout).toContain(value);
  });
  it("shows a disabled webhook installation's scope, event subscriptions and lifecycle", async () => {
    const data = {
      ...installation,
      runtime: "webhook",
      status: "disabled",
      sendMode: "approval",
      scope: {
        mailboxIds: [mailboxId, "mbx_2234567890123456"],
        namespaceId: "ns_1234567890123456",
      },
      webhook: { endpointId: "wep_1234567890123456", url: "https://example.com/events" },
      updatedAt: "2026-10-07T01:02:03.000Z",
      disabledAt: "2026-10-08T01:02:03.000Z",
    };
    for (const command of ["installation", "disable", "enable"]) {
      const result = await run([command, id], data);
      expect(result.code, result.stderr).toBe(0);
      for (const value of [
        id,
        data.extensionId,
        data.name,
        data.displayName,
        data.version.id,
        data.version.version,
        "webhook",
        "disabled",
        "approval",
        "read, send",
        "mailbox.message.received",
        ...data.scope.mailboxIds,
        data.scope.namespaceId,
        data.webhook.endpointId,
        data.webhook.url,
        data.createdAt,
        data.updatedAt,
        data.disabledAt,
      ])
        expect(result.stdout).toContain(value);
    }
  });
  it("distinguishes a hosted installation's unrestricted scope and absent webhook", async () => {
    const result = await run(["installation", id], installation);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("All accessible mailboxes");
    expect(result.stdout).toContain("All namespaces");
    expect(result.stdout).toMatch(/Webhook\s+None/);
    expect(result.stdout).toMatch(/Disabled\s+No/);
  });
  it("distinguishes an empty mailbox scope and a published manifest with no description", async () => {
    const scoped = await run(["installation", id], {
      ...installation,
      scope: { ...installation.scope, mailboxIds: [] },
    });
    expect(scoped.code, scoped.stderr).toBe(0);
    expect(scoped.stdout).toMatch(/Mailboxes\s+None/);
    const published = await run(["version", "auto-reply", "1.0.0"], {
      ...version,
      manifest: { ...manifest, description: null },
    });
    expect(published.code, published.stderr).toBe(0);
    expect(published.stdout).toMatch(/Description\s+None/);
  });
  it("keeps run start time, failure details and every retained log line", async () => {
    const data = {
      ...hostedRun,
      outcome: "failed",
      error: "Recipient refused",
      logs: Array.from({ length: 100 }, (_, index) => `Log ${index}: ${"x".repeat(180)}`),
    };
    const human = await run(["run", id, "run_test"], data);
    const machine = await run(["run", id, "run_test", "--json"], data);
    expect(human.code, human.stderr).toBe(0);
    expect(machine.code, machine.stderr).toBe(0);
    expect(JSON.parse(machine.stdout)).toEqual(data);
    for (const value of [
      data.id,
      data.eventId,
      data.eventType,
      date,
      "failed",
      data.error,
      ...data.logs,
    ])
      expect(human.stdout).toContain(value);
    expect(human.stdout).toMatch(/Attempt\s+1/);
    expect(human.stdout).toMatch(/Duration \(ms\)\s+13/);
    const listed = await run(["runs", id], { items: [data] });
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain(date);
    expect(listed.stdout).toContain(data.error);
  });
  it("refuses a cursor it did not print", async () => {
    const result = await run(["list", "--cursor", "not-a-cursor"], page([]));
    expect(result.code).toBe(2);
    expect(requests).toHaveLength(0);
  });
  it("forwards every installation option", async () => {
    const result = await run(
      [
        "install",
        "auto-reply",
        "--version",
        "1.0.0",
        "--mailbox",
        mailboxId,
        "--mailbox",
        "mbx_2234567890123456",
        "--namespace",
        "ns_1234567890123456",
        "--permission",
        "read",
        "--permission",
        "send",
        "--send-mode",
        "approval",
        "--webhook-url",
        "https://example.com/events",
        "--json",
      ],
      installResponse,
      201,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(requests[0]?.body).toEqual({
      extension: "auto-reply",
      version: "1.0.0",
      mailboxIds: [mailboxId, "mbx_2234567890123456"],
      namespaceId: "ns_1234567890123456",
      permissions: ["read", "send"],
      sendMode: "approval",
      webhookUrl: "https://example.com/events",
    });
  });
  for (const json of [false, true])
    it(`reveals webhook credentials once in ${json ? "JSON" : "human output"}`, async () => {
      const data = {
        installation: {
          ...installation,
          runtime: "webhook",
          webhook: { endpointId: "wep_1234567890123456", url: "https://example.com/events" },
        },
        credentials: { apiKey: "sk_installation_test", webhookSecret: "whsec_test" },
      };
      const result = await run(["install", "auto-reply", ...(json ? ["--json"] : [])], data, 201);
      expect(result.code, result.stderr).toBe(0);
      if (json) expect(JSON.parse(result.stdout)).toEqual(data);
      else expect(result.stdout).toContain("Store these now; they are not shown again.");
      expect(result.stdout.split("sk_installation_test")).toHaveLength(2);
      expect(result.stdout.split("whsec_test")).toHaveLength(2);
    });
  for (const args of [
    ["uninstall", id],
    ["uninstall", id, "--json"],
  ])
    it(`requires uninstall confirmation: ${args.join(" ")}`, async () => {
      const result = await run(args, { success: true });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("--yes");
      expect(requests).toHaveLength(0);
      expect(result.stdout).toBe("");
    });
  it("allows API key reads", async () => {
    const result = await run(["list", "--json"], page([extension]), 200, false);
    expect(result.code, result.stderr).toBe(0);
    assertRequest("GET", "/v1/extensions", false);
  });
  for (const args of [
    ["install", "auto-reply"],
    ["disable", id],
    ["enable", id],
    ["uninstall", id, "--yes"],
    ["upgrade", id, "--yes"],
    ["upgrade", id, "--dry-run"],
  ])
    it(`maps person refusal for ${args[0]}`, async () => {
      const result = await run(
        [...args, "--json"],
        { _tag: "ForbiddenError", message: "API key refused" },
        403,
        false,
      );
      expect(result.code).toBe(4);
      expect(result.stderr).toContain("samva login");
      expect(result.stderr).toContain("an API key cannot");
      expect(result.stdout).toBe("");
    });
  it("maps authentication failure", async () => {
    const result = await run(
      ["list", "--json"],
      { _tag: "UnauthorizedError", message: "Invalid API key" },
      401,
    );
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("samva login");
    expect(result.stdout).toBe("");
  });
  it("maps a gated route failure", async () => {
    const result = await run(["list", "--json"], undefined, 404);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("`mailbox` launch flag");
    expect(result.stdout).toBe("");
  });
  for (const command of ["list", "installations", "versions", "runs"])
    it(`renders an empty ${command} result`, async () => {
      const result = await run(
        [command, ...(command === "versions" ? ["auto-reply"] : command === "runs" ? [id] : [])],
        command === "runs" ? { items: [] } : page([]),
      );
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("No ");
    });
});
