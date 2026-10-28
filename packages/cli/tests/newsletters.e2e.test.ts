import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "@effect/vitest";

import { runCli } from "./support/run-cli";

it("routes newsletter management and domain commands with header-only idempotency", async () => {
  const id = "nl_1234567890abcdef";
  const topicId = "unsub_1234567890abcdef";
  const newsletter = {
    id,
    topicId,
    name: "Weekly",
    description: null,
    namespaceId: null,
    issueProjectId: null,
    archiveEnabled: false,
    publicationSlug: null,
    createdAt: "2026-10-28T00:00:00Z",
    updatedAt: "2026-10-28T00:00:00Z",
  };
  const requests: Array<{
    method: string;
    path: string;
    body: unknown;
    key: string | string[] | undefined;
  }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const url = new URL(request.url ?? "/", "http://localhost");
    url.searchParams.sort();
    const path = `${url.pathname}${url.search}`;
    requests.push({
      method: request.method ?? "GET",
      path,
      body: body ? JSON.parse(body) : null,
      key: request.headers["idempotency-key"],
    });
    let result: unknown = newsletter;
    if (request.method === "DELETE" && !path.includes("/domains")) result = { success: true };
    else if (path.includes("/domains"))
      result = {
        organizationId: "org_1234567890abcdef",
        topicId,
        hostname: "news.example.com",
        canonicalHostname: "weekly.samva.app",
        phase: request.method === "DELETE" ? "removed" : "active",
        active: request.method !== "DELETE",
        hostnameStatus: "active",
        sslStatus: "active",
        cname: { type: "CNAME", name: "news.example.com", value: "origin.samva.app" },
        verificationRecords: [],
        verificationErrors: [],
      };
    if (request.method === "GET" && url.pathname === `/v1/newsletters/${id}/domains`)
      result = { items: [result], nextCursor: null };
    else if (request.method === "GET" && path === "/v1/newsletters")
      result = { items: [newsletter], nextCursor: null };
    response.writeHead(request.method === "POST" && path === "/v1/newsletters" ? 201 : 200, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify(result));
  });
  const configHome = await mkdtemp(join(tmpdir(), "samva-newsletters-"));
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Test server did not bind TCP");
    const env = {
      SAMVA_API_KEY: "samva_sk_test_x",
      SAMVA_API_URL: `http://127.0.0.1:${address.port}`,
    };
    const commands = [
      ["list"],
      ["get", id],
      ["create", "--topic-id", topicId, "--idempotency-key", "create-key"],
      [
        "update",
        id,
        "--archive",
        "enabled",
        "--publication-slug",
        "weekly",
        "--idempotency-key",
        "update-key",
      ],
      ["domains", "add", id, "news.example.com", "--idempotency-key", "domain-key"],
      ["domains", "list", id, "--limit", "2", "--cursor", "bmV3cy5leGFtcGxlLmNvbQ"],
      ["domains", "get", id, "news.example.com"],
      [
        "domains",
        "remove",
        id,
        "news.example.com",
        "--yes",
        "--idempotency-key",
        "remove-domain-key",
      ],
      ["delete", id, "--yes", "--idempotency-key", "delete-key"],
    ];
    for (const args of commands) {
      const result = await runCli(["newsletters", ...args, "--json"], { configHome, env });
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).command).toBe(
        `newsletters.${args[0] === "domains" ? `domains.${args[1]}` : args[0]}`,
      );
    }
    expect(requests).toEqual([
      { method: "GET", path: "/v1/newsletters", body: null, key: undefined },
      { method: "GET", path: `/v1/newsletters/${id}`, body: null, key: undefined },
      { method: "POST", path: "/v1/newsletters", body: { topicId }, key: "create-key" },
      {
        method: "PATCH",
        path: `/v1/newsletters/${id}`,
        body: { archiveEnabled: true, publicationSlug: "weekly" },
        key: "update-key",
      },
      {
        method: "POST",
        path: `/v1/newsletters/${id}/domains`,
        body: { hostname: "news.example.com" },
        key: "domain-key",
      },
      {
        method: "GET",
        path: `/v1/newsletters/${id}/domains?cursor=bmV3cy5leGFtcGxlLmNvbQ&limit=2`,
        body: null,
        key: undefined,
      },
      {
        method: "GET",
        path: `/v1/newsletters/${id}/domains/news.example.com`,
        body: null,
        key: undefined,
      },
      {
        method: "DELETE",
        path: `/v1/newsletters/${id}/domains/news.example.com`,
        body: null,
        key: "remove-domain-key",
      },
      { method: "DELETE", path: `/v1/newsletters/${id}`, body: null, key: "delete-key" },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(configHome, { recursive: true, force: true });
  }
}, 120_000);
