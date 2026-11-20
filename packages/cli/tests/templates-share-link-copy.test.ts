import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest";

import { createTestServer } from "./support/http-server";
import { runCli } from "./support/run-cli";

const shareLinkSlug = "for-context-dev";
const projectId = "tproj_1234567890abcdef";
const template = {
  id: "tmpl_1234567890abcdef",
  projectId,
  namespaceId: null,
  shared: false,
  entryPath: "templates/welcome.tsx",
  name: "Welcome",
  slug: "welcome",
  familyId: null,
  channel: "email",
  description: null,
  category: null,
  email: { subject: "Welcome aboard", preheader: null, headers: null },
  sms: null,
  whatsapp: null,
  publicationId: null,
  brand: null,
  inputContractId: null,
  inputSchema: null,
  usageCount: 0,
  lastUsedAt: null,
  status: "draft",
  publishedAt: null,
  fromDefault: null,
  replyToDefault: null,
  trackingDefault: null,
  createdAt: "2026-11-15T00:00:00.000Z",
  updatedAt: "2026-11-15T00:00:00.000Z",
};
const requests: {
  method: string | undefined;
  path: string | undefined;
  body: unknown;
  key: string | string[] | undefined;
}[] = [];
let configHome = "";
let apiUrl = "";
let unavailable = false;
const server = createTestServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  requests.push({
    method: req.method,
    path: req.url,
    body: raw ? JSON.parse(raw) : undefined,
    key: req.headers["idempotency-key"],
  });
  res.writeHead(unavailable ? 410 : 201, { "content-type": "application/json" });
  res.end(
    JSON.stringify(
      unavailable
        ? { _tag: "ShareLinkUnavailable", message: "The share link is unavailable." }
        : template,
    ),
  );
});
beforeAll(async () => {
  configHome = await mkdtemp(join(tmpdir(), "samva-starter-copy-"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(configHome, { recursive: true, force: true });
});
beforeEach(() => {
  requests.length = 0;
  unavailable = false;
});
const cli = (payload: unknown, flags: string[] = [], authenticated = true) =>
  runCli(["templates", "create", "--data", JSON.stringify(payload), ...flags], {
    configHome,
    env: {
      SAMVA_API_URL: apiUrl,
      ...(authenticated ? { SAMVA_API_KEY: "samva_sk_test_starter_copy" } : {}),
    },
  });

describe("signed-in share link copy", () => {
  it("creates from only shareLinkSlug and returns the copied project's id", async () => {
    const result = await cli({ shareLinkSlug }, [
      "--idempotency-key",
      "stable-starter-copy",
      "--json",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).data).toEqual(template);
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/v1/templates",
        body: { shareLinkSlug },
        key: "stable-starter-copy",
      },
    ]);
  });
  it("previews without authentication or API calls in JSON and human modes", async () => {
    const machine = await cli({ shareLinkSlug }, ["--dry-run", "--json"], false);
    expect(machine.code, machine.stderr).toBe(0);
    expect(JSON.parse(machine.stdout).data).toEqual({
      dryRun: true,
      action: "templates.create",
      request: { shareLinkSlug },
    });
    const human = await cli({ shareLinkSlug }, ["--dry-run"], false);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain(shareLinkSlug);
    expect(requests).toEqual([]);
  });
  it.each([
    { name: "A different name" },
    { projectName: "other" },
    { galleryTemplateId: "gal_other" },
    { namespaceId: "ns_1234567890abcdef" },
    { shared: false },
    { useBrand: true },
  ])("refuses mixing shareLinkSlug with %j", async (extra) => {
    const result = await cli({ shareLinkSlug, ...extra }, ["--dry-run", "--json"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("share link");
    expect(requests).toEqual([]);
  });
  it.each([["--namespace", "ns_1234567890abcdef"], ["--shared"]])(
    "refuses source-copy placement flags %j",
    async (...flags) => {
      const result = await cli({ shareLinkSlug }, [...flags, "--json"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("share link");
      expect(requests).toEqual([]);
    },
  );
  it("preserves 410 status and recovery guidance when the link is unavailable", async () => {
    unavailable = true;
    const result = await cli({ shareLinkSlug }, ["--json"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      reason: "ShareLinkUnavailable",
      status: 410,
      next: expect.stringContaining("renamed or deleted"),
    });
    expect(requests).toHaveLength(1);
  });
  it("reuses an explicitly supplied retry key across invocations", async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await cli({ shareLinkSlug }, [
        "--idempotency-key",
        "retry-one-copy",
        "--json",
      ]);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).data.projectId).toBe(projectId);
    }
    expect(requests.map(({ key, body }) => ({ key, body }))).toEqual([
      { key: "retry-one-copy", body: { shareLinkSlug } },
      { key: "retry-one-copy", body: { shareLinkSlug } },
    ]);
  });
});
