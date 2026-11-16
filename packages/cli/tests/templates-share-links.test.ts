import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest";

import { runCli } from "./support/run-cli";

const projectId = "tproj_2eqcmea000000000";
const status = {
  slug: "for-context-dev",
  url: "https://samva.dev/t/for-context-dev",
  canonicalPath: "/t/for-context-dev",
  views: 12,
  opens: 4,
  updatedAt: "2026-11-15T00:00:00.000Z",
};
const requests: { method: string | undefined; path: string | undefined; body: unknown }[] = [];
let configHome = "";
let apiUrl = "";
let response: unknown = status;
let responseStatus = 200;
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : undefined });
  res.writeHead(responseStatus, { "content-type": "application/json" });
  res.end(
    JSON.stringify(
      req.method === "DELETE" && responseStatus === 200 ? { deleted: true } : response,
    ),
  );
});
beforeAll(async () => {
  configHome = await mkdtemp(join(tmpdir(), "samva-starters-"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(configHome, { recursive: true, force: true });
});
beforeEach(() => {
  requests.length = 0;
  response = status;
  responseStatus = 200;
});
const cli = (args: string[]) =>
  runCli(["templates", "share-link", ...args], {
    configHome,
    env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "samva_sk_test_starters" },
  });

describe("share link commands", () => {
  it.each([
    ["create", ["--slug", "for-context-dev"]],
    ["update", []],
    ["rename", ["--slug", "for-new-name"]],
    ["delete", []],
  ] as const)("%s dry-run is offline and exposes the intended request", async (command, flags) => {
    const result = await cli([command, projectId, ...flags, "--dry-run", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).data).toMatchObject({
      dryRun: true,
      action: `templates.share-link.${command}`,
      projectId,
      ...(command === "create" ? { slug: "for-context-dev" } : {}),
      ...(command === "rename" ? { slug: "for-new-name" } : {}),
    });
    expect(requests).toEqual([]);
  });
  it("publishes with the optional slug and updates at the same project", async () => {
    for (const args of [
      ["create", projectId, "--slug", status.slug],
      ["create", projectId],
      ["update", projectId],
    ]) {
      const result = await cli([...args, "--json"]);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).data).toEqual(status);
    }
    expect(requests).toEqual([
      {
        method: "POST",
        path: `/v1/template-projects/${projectId}/share-link`,
        body: { slug: status.slug },
      },
      { method: "POST", path: `/v1/template-projects/${projectId}/share-link`, body: {} },
      {
        method: "POST",
        path: `/v1/template-projects/${projectId}/share-link/update`,
        body: undefined,
      },
    ]);
  });
  it("gets and renders the full status and an deleted result", async () => {
    const human = await cli(["get", projectId]);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain(status.url);
    expect(human.stdout).toContain("12");
    expect(human.stdout).toContain("4");
    const machine = await cli(["get", projectId, "--json"]);
    expect(machine.code, machine.stderr).toBe(0);
    expect(JSON.parse(machine.stdout).data).toEqual(status);
    response = null;
    const deleted = await cli(["get", projectId, "--json"]);
    expect(deleted.code, deleted.stderr).toBe(0);
    expect(JSON.parse(deleted.stdout).data).toBeNull();
    const noStarter = await cli(["get", projectId]);
    expect(noStarter.code, noStarter.stderr).toBe(0);
    expect(noStarter.stdout).toContain("Not created");
  });
  it("renames the slug and confirms delete before any request", async () => {
    const refused = await cli(["delete", projectId, "--json"]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("--yes");
    expect(requests).toEqual([]);
    const renamed = await cli(["rename", projectId, "--slug", "for-new-name", "--json"]);
    expect(renamed.code, renamed.stderr).toBe(0);
    const deleted = await cli(["delete", projectId, "--yes", "--json"]);
    expect(deleted.code, deleted.stderr).toBe(0);
    expect(JSON.parse(deleted.stdout).data).toEqual({ deleted: true });
    expect(requests).toEqual([
      {
        method: "PATCH",
        path: `/v1/template-projects/${projectId}/share-link`,
        body: { slug: "for-new-name" },
      },
      { method: "DELETE", path: `/v1/template-projects/${projectId}/share-link`, body: undefined },
    ]);
  });
  it.each(["Uppercase", "ab", "has_underscore", "a".repeat(61)])(
    "rejects invalid slug %s before network",
    async (slug) => {
      const result = await cli(["create", projectId, "--slug", slug, "--json"]);
      expect(result.code).toBe(2);
      expect(requests).toEqual([]);
    },
  );
  it("preserves the SlugTaken suggestion as an API error", async () => {
    responseStatus = 409;
    response = {
      _tag: "SlugTaken",
      message: "Slug is already taken",
      slug: status.slug,
      suggestion: "for-context-dev-2",
    };
    const result = await cli(["create", projectId, "--slug", status.slug, "--json"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      reason: "SlugTaken",
      details: { suggestion: "for-context-dev-2" },
    });
  });
  it("publishes help for every subcommand without contacting the API", async () => {
    for (const command of ["create", "update", "get", "rename", "delete"]) {
      const result = await cli([command, "--help", "--json"]);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).data).toMatchObject({
        description: expect.any(String),
        usage: expect.any(String),
      });
    }
    expect(requests).toEqual([]);
  });
});
