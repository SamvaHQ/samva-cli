import { mkdtemp, rm } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { runCli as runCliProcess } from "./support/run-cli";

const family = {
  id: "tfam_aaaaaaaaaaaaaaaa",
  name: "Shipped",
  namespaceId: null,
  members: [],
  createdAt: "2026-11-17T00:00:00Z",
  updatedAt: "2026-11-17T00:00:00Z",
};
let configHome: string;
let api: ReturnType<typeof createServer>;
let url: string;
let requests: Array<{ method: string; path: string; body: string }>;
beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), "samva-families-"));
  requests = [];
  api = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      requests.push({ method: req.method ?? "", path: req.url ?? "", body });
      res.writeHead(req.method === "POST" && req.url === "/v1/templates/families" ? 201 : 200, {
        "content-type": "application/json",
      });
      res.end(
        JSON.stringify(
          req.method === "GET" && req.url?.includes("?")
            ? { items: [family], nextCursor: null }
            : family,
        ),
      );
    });
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await rm(configHome, { recursive: true, force: true });
});
const runCli = (args: ReadonlyArray<string>) =>
  runCliProcess(args, {
    configHome,
    env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: url },
  });
describe("template family CLI", () => {
  it("list sends the expected request", async () => {
    const result = await runCli(["templates", "families", ...["list", "--limit", "2"], "--json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      type: "result",
      command: "templates.families.list",
    });
    expect(requests).toEqual([{ method: "GET", path: "/v1/templates/families?limit=2", body: "" }]);
  });
  it("list and create name a namespace", async () => {
    const namespace = ["--namespace", "ns_aaaaaaaaaaaaaaaa"];
    const listed = await runCli(["templates", "families", "list", ...namespace, "--json"]);
    expect(listed).toMatchObject({ code: 0, stderr: "" });
    const created = await runCli([
      "templates",
      "families",
      ...["create", "--name", "Shipped", ...namespace],
      "--json",
    ]);
    expect(created).toMatchObject({ code: 0, stderr: "" });
    expect(requests).toEqual([
      {
        method: "GET",
        path: "/v1/templates/families?limit=20&namespaceId=ns_aaaaaaaaaaaaaaaa",
        body: "",
      },
      {
        method: "POST",
        path: "/v1/templates/families",
        body: '{"name":"Shipped","namespaceId":"ns_aaaaaaaaaaaaaaaa"}',
      },
    ]);
  });
  it("get sends the expected request", async () => {
    const result = await runCli([
      "templates",
      "families",
      ...["get", "tfam_aaaaaaaaaaaaaaaa"],
      "--json",
    ]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      type: "result",
      command: "templates.families.get",
    });
    expect(requests).toEqual([
      { method: "GET", path: "/v1/templates/families/tfam_aaaaaaaaaaaaaaaa", body: "" },
    ]);
  });
  it("create sends the expected request", async () => {
    const result = await runCli([
      "templates",
      "families",
      ...["create", "--name", "Shipped"],
      "--json",
    ]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      type: "result",
      command: "templates.families.create",
    });
    expect(requests).toEqual([
      { method: "POST", path: "/v1/templates/families", body: '{"name":"Shipped"}' },
    ]);
  });
  it("attach sends the expected request", async () => {
    const result = await runCli([
      "templates",
      "families",
      ...["attach", "tfam_aaaaaaaaaaaaaaaa", "tmpl_aaaaaaaaaaaaaaaa"],
      "--json",
    ]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      type: "result",
      command: "templates.families.attach",
    });
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/v1/templates/families/tfam_aaaaaaaaaaaaaaaa/members/tmpl_aaaaaaaaaaaaaaaa",
        body: "",
      },
    ]);
  });
  it("detach sends the expected request", async () => {
    const result = await runCli([
      "templates",
      "families",
      ...["detach", "tfam_aaaaaaaaaaaaaaaa", "tmpl_aaaaaaaaaaaaaaaa", "--yes"],
      "--json",
    ]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      type: "result",
      command: "templates.families.detach",
    });
    expect(requests).toEqual([
      {
        method: "DELETE",
        path: "/v1/templates/families/tfam_aaaaaaaaaaaaaaaa/members/tmpl_aaaaaaaaaaaaaaaa",
        body: "",
      },
    ]);
  });
  it("previews detach without a request and refuses an unconfirmed noninteractive detach", async () => {
    const args = ["templates", "families", "detach", family.id, "tmpl_aaaaaaaaaaaaaaaa", "--json"];
    expect((await runCli([...args, "--dry-run"])).code).toBe(0);
    expect((await runCli(args)).code).not.toBe(0);
    expect(requests).toEqual([]);
  });
});
