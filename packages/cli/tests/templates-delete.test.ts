import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest";

import { runCli } from "./support/run-cli";

const projectId = "tproj_2eqcmea000000000";
const templateId = "tmpl_2eqcmea000000000";
const now = "2026-11-06T00:00:00.000Z";
const template = {
  id: templateId,
  projectId,
  name: "Welcome",
  slug: "welcome",
  channel: "email",
  namespaceId: null,
  shared: false,
  entryPath: "templates/welcome.tsx",
  status: "draft",
  publishedAt: null,
  brand: null,
  fromDefault: null,
  usageCount: 0,
  lastUsedAt: null,
  createdAt: now,
  updatedAt: now,
  familyId: null,
  description: null,
  category: null,
  email: null,
  sms: null,
  whatsapp: null,
  replyToDefault: null,
  trackingDefault: null,
  publicationId: null,
  inputContractId: null,
  inputSchema: null,
};
let home = "";
let url = "";
let conflict = false;
const requests: string[] = [];
const server = createServer((req, res) => {
  const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
  requests.push(`${req.method} ${parsed.pathname}${parsed.search}`);
  res.setHeader("content-type", "application/json");
  if (req.method === "DELETE") {
    res.statusCode = conflict ? 409 : 200;
    res.end(
      JSON.stringify(
        conflict
          ? {
              _tag: "TemplateInUseError",
              message: "Template is still in use",
              references: [{ kind: "journey", id: "jrny_example" }],
            }
          : { success: true },
      ),
    );
    return;
  }
  if (parsed.pathname === "/v1/templates") {
    const second = parsed.searchParams.has("cursor");
    res.end(
      JSON.stringify({
        items: [
          {
            ...template,
            id: second ? "tmpl_3eqcmea000000000" : templateId,
            name: second ? "Second" : "Welcome",
            slug: second ? "second" : "welcome",
          },
        ],
        nextCursor: second ? null : "second-page",
      }),
    );
    return;
  }
  res.end(JSON.stringify(template));
});
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "samva-template-delete-"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
});
beforeEach(() => {
  requests.length = 0;
  conflict = false;
});
const run = (args: string[]) =>
  runCli(args, {
    configHome: home,
    env: { SAMVA_API_KEY: "samva_sk_test_delete", SAMVA_API_URL: url },
  });

describe("permanent template deletion", () => {
  it("requires --yes before making any request", async () => {
    for (const args of [
      ["templates", "delete", templateId],
      ["templates", "projects", "delete", projectId],
    ]) {
      const result = await run([...args, "--json"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("--yes");
    }
    expect(requests).toEqual([]);
  });
  it("previews the actual template without mutating it", async () => {
    const result = await run(["templates", "delete", templateId, "--dry-run", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({
      dryRun: true,
      action: "templates.delete",
      template: { id: templateId, name: "Welcome", slug: "welcome" },
    });
    expect(requests).toEqual([`GET /v1/templates/${templateId}`]);
  });
  it("lists every page of a project's templates during preview", async () => {
    const result = await run(["templates", "projects", "delete", projectId, "--dry-run", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(
      JSON.parse(result.stdout).data.templates.map((entry: { name: string }) => entry.name),
    ).toEqual(["Welcome", "Second"]);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.startsWith("GET /v1/templates?"))).toBe(true);
    expect(requests.every((request) => request.includes(`projectId=${projectId}`))).toBe(true);
  });
  it("sends exactly one delete for each confirmed command", async () => {
    for (const args of [
      ["templates", "delete", templateId],
      ["templates", "projects", "delete", projectId],
    ]) {
      const result = await run([...args, "--yes", "--json"]);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).data).toEqual({ success: true });
    }
    expect(requests).toEqual([
      `DELETE /v1/templates/${templateId}`,
      `DELETE /v1/templates/projects/${projectId}`,
    ]);
  });
  it("preserves blocker references in machine and human failures", async () => {
    conflict = true;
    const machine = await run(["templates", "delete", templateId, "--yes", "--json"]);
    expect(machine.code).not.toBe(0);
    expect(machine.stdout).toBe("");
    expect(machine.stderr).toContain("TemplateInUseError");
    expect(machine.stderr).toContain("jrny_example");
    const human = await run(["templates", "projects", "delete", projectId, "--yes"]);
    expect(human.code).not.toBe(0);
    expect(human.stderr).toContain("journey: jrny_example");
    expect(requests).toHaveLength(2);
  });
});
