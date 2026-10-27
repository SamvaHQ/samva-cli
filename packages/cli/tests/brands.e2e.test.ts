import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { resolveProjectBrand } from "../src/commands/templates/brand-resolver";
import { runCli as runCliProcess, type CliOptions } from "./support/run-cli";

// Process-level contract for `samva brands`: the real CLI against a stub API,
// asserting the result envelope, stream separation, exit codes, and the
// snapshot file `pull` writes.

const now = "2026-09-26T00:00:00.000Z";
const brand = (slug: string, isDefault: boolean) => ({
  id: "brand_7q2xk9mvt4znw8rh",
  slug,
  name: slug === "acme" ? "Acme" : "Promo",
  isDefault,
  css: "@theme { --color-primary: #e11d48; }",
  assets: { logoUrl: "https://cdn.example.com/logo.png" },
  footer: { companyName: "Acme Inc." },
  digest: `${slug}-digest`,
  createdAt: now,
  updatedAt: now,
});

interface Request {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

const startApi = (): Promise<{
  url: string;
  requests: ReadonlyArray<Request>;
  close: () => Promise<void>;
}> =>
  new Promise((resolve) => {
    let brands = [brand("acme", true), brand("promo", false)];
    const requests: Array<Request> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += String(chunk)));
      req.on("end", () => {
        requests.push({ method: req.method ?? "", url: req.url ?? "", body });
        const slug = /^\/v1\/brands\/([a-z0-9-]+)(?:\/default)?$/.exec(req.url ?? "")?.[1];
        const found = brands.find((item) => item.slug === slug);
        const reply = (status: number, value: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(value));
        };
        if (req.method === "GET" && req.url === "/v1/brands") return reply(200, { items: brands });
        if (found === undefined)
          return reply(404, {
            _tag: "ResourceNotFoundError",
            resource: "brand",
            id: slug,
            message: "Brand not found",
          });
        if (req.method === "GET") return reply(200, found);
        if (req.method === "POST" && req.url?.endsWith("/default")) {
          brands = brands.map((item) => ({ ...item, isDefault: item.slug === found.slug }));
          return reply(200, { ...found, isDefault: true });
        }
        if (req.method === "DELETE") {
          if (found.isDefault)
            return reply(409, {
              _tag: "ConflictError",
              resource: "brand",
              id: found.slug,
              message: "The default brand cannot be deleted.",
            });
          brands = brands.filter((item) => item.slug !== found.slug);
          return reply(200, { success: true });
        }
        if (req.method === "PATCH") {
          const { css } = JSON.parse(body) as { css: string };
          return reply(200, { ...found, css, digest: "pushed-digest" });
        }
        return reply(405, {});
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });

const parseResult = <T>(stdout: string, command: string): T => {
  const envelope = JSON.parse(stdout) as { data: T };
  expect(envelope).toMatchObject({ schemaVersion: 1, type: "result", command });
  return envelope.data;
};

let configHome = "";
let project = "";
let api: Awaited<ReturnType<typeof startApi>>;

const runCli = (args: ReadonlyArray<string>, options: Omit<CliOptions, "configHome"> = {}) =>
  runCliProcess(args, {
    configHome,
    cwd: project,
    env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url },
    ...options,
  });

beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), "samva-cli-brands-"));
  project = await mkdtemp(join(tmpdir(), "samva-brands-project-"));
  api = await startApi();
});

afterEach(async () => {
  await api.close();
  await rm(configHome, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

const VALID_CSS = "@theme {\n  --color-primary: #0f766e;\n}\n";

describe("samva brands pull", () => {
  it("snapshots the default brand where samva:brand resolves it offline", async () => {
    const result = await runCli(["brands", "pull", "--json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(parseResult(result.stdout, "brands.pull")).toMatchObject({
      action: "brands.pull",
      slug: "acme",
      isDefault: true,
      digest: "acme-digest",
      path: join(".samva", "brands", "acme.json"),
    });
    const snapshot = JSON.parse(
      await readFile(join(project, ".samva", "brands", "acme.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      version: 1,
      slug: "acme",
      name: "Acme",
      isDefault: true,
      css: brand("acme", true).css,
      assets: brand("acme", true).assets,
      footer: brand("acme", true).footer,
      digest: "acme-digest",
      pulledAt: expect.any(String),
    });

    // The reader the CLI uses for `samva:brand`: the pulled snapshot resolves through it.
    const offline = await resolveProjectBrand({
      root: project,
      files: { "theme.css": '@import "samva:brand";' },
      themePath: "theme.css",
      env: { PATH: configHome },
    });
    expect(offline).toMatchObject({
      ok: true,
      source: "snapshot",
      brand: { slug: "acme", digest: "acme-digest" },
    });
  });

  it("snapshots a named brand and never writes theme.css", async () => {
    await writeFile(join(project, "theme.css"), '@import "samva:brand/promo";\n');
    const result = await runCli(["brands", "pull", "promo"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("Pulled brand promo");
    expect(await readFile(join(project, "theme.css"), "utf8")).toBe(
      '@import "samva:brand/promo";\n',
    );
    const snapshot = JSON.parse(
      await readFile(join(project, ".samva", "brands", "promo.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(snapshot).toMatchObject({ slug: "promo", isDefault: false });
    expect(api.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET /v1/brands/promo",
    ]);
  });

  it("fails with the auth exit code and an empty stdout without credentials", async () => {
    const result = await runCli(["brands", "pull", "--json"], { env: {} });
    expect(result.code).toBe(4);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      type: "error",
      command: "brands.pull",
      reason: "missing_credentials",
    });
  });
});

describe("samva brands push", () => {
  it("uploads valid CSS to the brand --brand names", async () => {
    await writeFile(join(project, "brand.css"), VALID_CSS);
    const result = await runCli(["brands", "push", "brand.css", "--brand", "promo", "--json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(parseResult(result.stdout, "brands.push")).toEqual({
      action: "brands.push",
      file: "brand.css",
      slug: "promo",
      digest: "pushed-digest",
      ok: true,
    });
    expect(api.requests).toEqual([
      { method: "PATCH", url: "/v1/brands/promo", body: JSON.stringify({ css: VALID_CSS }) },
    ]);
  });

  it("renames the brand in the same update when --name is given", async () => {
    await writeFile(join(project, "brand.css"), VALID_CSS);
    const result = await runCli([
      "brands",
      "push",
      "brand.css",
      "--name",
      "Samva",
      "--brand",
      "promo",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(api.requests).toEqual([
      {
        method: "PATCH",
        url: "/v1/brands/promo",
        body: JSON.stringify({ name: "Samva", css: VALID_CSS }),
      },
    ]);
  });

  it("updates the default brand when --brand is omitted", async () => {
    await writeFile(join(project, "brand.css"), VALID_CSS);
    const result = await runCli(["brands", "push", "brand.css", "--json"]);
    expect(result.code).toBe(0);
    expect(parseResult(result.stdout, "brands.push")).toMatchObject({ slug: "acme" });
    expect(api.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET /v1/brands",
      "PATCH /v1/brands/acme",
    ]);
  });

  it("refuses CSS outside the brand grammar with located findings and uploads nothing", async () => {
    await writeFile(
      join(project, "brand.css"),
      "@theme {\n  --color-primary: red;\n}\n.a { color: red; }\n",
    );
    const result = await runCli(["brands", "push", "brand.css", "--json"]);
    expect(result.code).toBe(1);
    const data = parseResult<{ ok: boolean; findings: Array<{ line: number }> }>(
      result.stdout,
      "brands.push",
    );
    expect(data).toMatchObject({ action: "brands.push", file: "brand.css", ok: false });
    expect(data.findings).toContainEqual(expect.objectContaining({ line: 4, column: 1 }));
    expect(JSON.parse(result.stderr)).toMatchObject({
      type: "error",
      command: "brands.push",
      reason: "invalid_brand_css",
    });
    expect(api.requests).toEqual([]);

    const human = await runCli(["brands", "push", "brand.css"]);
    expect(human.code).toBe(1);
    expect(human.stdout).toContain("brand.css:4:1");
  });

  it("validates offline with --dry-run", async () => {
    await writeFile(join(project, "brand.css"), VALID_CSS);
    const result = await runCli(["brands", "push", "brand.css", "--dry-run", "--json"], {
      env: {},
    });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(parseResult(result.stdout, "brands.push")).toEqual({
      dryRun: true,
      action: "brands.push",
      file: "brand.css",
      brand: null,
      ok: true,
    });
  });

  it("names an unreadable file as a usage error", async () => {
    const result = await runCli(["brands", "push", "missing.css", "--json"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ reason: "brand_css_unreadable" });
  });
});

describe("samva brands list and get", () => {
  it("lists brands in one envelope and marks the default for humans", async () => {
    const json = await runCli(["brands", "list", "--json"]);
    expect(json).toMatchObject({ code: 0, stderr: "" });
    expect(
      parseResult<{ items: Array<{ slug: string }> }>(json.stdout, "brands.list").items,
    ).toEqual([
      expect.objectContaining({ slug: "acme" }),
      expect.objectContaining({ slug: "promo" }),
    ]);
    const human = await runCli(["brands", "list"]);
    expect(human.stdout).toMatch(/^\* acme {2}Acme/m);
  });

  it("gets the default brand when no slug is given", async () => {
    const result = await runCli(["brands", "get", "--json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(parseResult(result.stdout, "brands.get")).toMatchObject({
      slug: "acme",
      digest: "acme-digest",
    });
  });
});

describe("samva brands default", () => {
  it("makes a brand the default", async () => {
    const result = await runCli(["brands", "default", "promo", "--json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(parseResult(result.stdout, "brands.default")).toEqual({
      action: "brands.default",
      slug: "promo",
      name: "Promo",
      isDefault: true,
    });
    expect(api.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "POST /v1/brands/promo/default",
    ]);
    const human = await runCli(["brands", "default", "acme"]);
    expect(human.stdout).toContain("Brand acme (Acme) is now the default.");
  });

  it("previews with --dry-run and sends nothing", async () => {
    const result = await runCli(["brands", "default", "promo", "--dry-run", "--json"], {
      env: {},
    });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(parseResult(result.stdout, "brands.default")).toEqual({
      dryRun: true,
      action: "brands.default",
      slug: "promo",
    });
    expect(api.requests).toEqual([]);
  });

  it("reports an unknown brand as an API error", async () => {
    const result = await runCli(["brands", "default", "missing", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      type: "error",
      command: "brands.default",
      reason: "ResourceNotFoundError",
    });
  });
});

describe("samva brands remove", () => {
  it("requires --yes outside a terminal and sends nothing without it", async () => {
    const result = await runCli(["brands", "remove", "promo", "--json"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      type: "error",
      command: "brands.remove",
      reason: "confirmation_required",
    });
    expect(api.requests).toEqual([]);
  });

  it("deletes a brand with --yes", async () => {
    const result = await runCli(["brands", "remove", "promo", "--yes", "--json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(parseResult(result.stdout, "brands.remove")).toEqual({
      action: "brands.remove",
      slug: "promo",
      removed: true,
    });
    expect(api.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "DELETE /v1/brands/promo",
    ]);
    const human = await runCli(["brands", "remove", "promo", "--yes"]);
    expect(human.code).toBe(1);
  });

  it("surfaces the API's refusal to delete the default brand", async () => {
    const result = await runCli(["brands", "remove", "acme", "--yes", "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      type: "error",
      command: "brands.remove",
      reason: "ConflictError",
      status: 409,
    });
  });

  it("previews with --dry-run and sends nothing", async () => {
    const result = await runCli(["brands", "remove", "promo", "--dry-run", "--json"], {
      env: {},
    });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(parseResult(result.stdout, "brands.remove")).toEqual({
      dryRun: true,
      action: "brands.remove",
      slug: "promo",
    });
    expect(api.requests).toEqual([]);
  });
});
