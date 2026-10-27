import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest";

import {
  BRAND_SNAPSHOT_DIR,
  resolveProjectBrand,
  type BrandSnapshot,
} from "../src/commands/templates/brand-resolver";

const THEME = { "theme.css": '@import "samva:brand";\n@theme { --radius-card: 4px; }\n' };

const brandBody = (overrides: Partial<BrandSnapshot> = {}) => ({
  id: "brand_7q2xk9mvt4znw8rh",
  slug: "acme",
  name: "Acme",
  isDefault: true,
  css: "@theme { --color-primary: #e11d48; }",
  assets: {},
  footer: { companyName: "Acme Inc." },
  digest: "live-digest",
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z",
  ...overrides,
});

const snapshot = (overrides: Partial<BrandSnapshot> = {}): BrandSnapshot => ({
  version: 1,
  slug: "acme",
  name: "Acme",
  isDefault: true,
  css: "@theme { --color-primary: #0f766e; }",
  assets: {},
  footer: { companyName: "Acme Inc." },
  digest: "snapshot-digest",
  pulledAt: "2026-09-25T12:00:00.000Z",
  ...overrides,
});

const writeSnapshot = async (root: string, value: BrandSnapshot) => {
  const directory = join(root, BRAND_SNAPSHOT_DIR);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${value.slug}.json`), JSON.stringify(value));
};

interface StubApi {
  readonly url: string;
  readonly requests: Array<{ readonly url: string; readonly headers: IncomingHttpHeaders }>;
  readonly close: () => Promise<void>;
}

const startApi = (items: ReadonlyArray<ReturnType<typeof brandBody>>): Promise<StubApi> =>
  new Promise((resolve) => {
    const requests: StubApi["requests"] = [];
    const server = createServer((req, res) => {
      requests.push({ url: req.url ?? "", headers: req.headers });
      const slug = /^\/v1\/brands\/([a-z0-9-]+)$/.exec(req.url ?? "")?.[1];
      const body = req.url === "/v1/brands" ? { items } : items.find((item) => item.slug === slug);
      res.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(body ?? { _tag: "ResourceNotFoundError" }));
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

describe("resolveProjectBrand", () => {
  let root: string;
  // A PATH with no `samva` on it: the machine running the tests may have a logged-in CLI.
  let emptyPath: string;
  beforeAll(async () => {
    emptyPath = await mkdtemp(join(tmpdir(), "samva-brand-path-"));
  });
  afterAll(async () => {
    await rm(emptyPath, { recursive: true, force: true });
  });
  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });
  const project = async () => {
    root = await mkdtemp(join(tmpdir(), "samva-brand-"));
    return root;
  };

  it("resolves nothing for a project that imports no brand", async () => {
    const resolution = await resolveProjectBrand({
      root: await project(),
      files: { "theme.css": "@theme { --color-primary: red; }" },
      themePath: "theme.css",
      env: { PATH: emptyPath },
    });
    expect(resolution).toEqual({ ok: true, brand: undefined, source: "none", warnings: [] });
  });

  it("falls back to the pulled snapshot offline, and says so", async () => {
    const dir = await project();
    await writeSnapshot(dir, snapshot());
    const resolution = await resolveProjectBrand({
      root: dir,
      files: THEME,
      themePath: "theme.css",
      env: { PATH: emptyPath },
    });
    expect(resolution).toMatchObject({
      ok: true,
      source: "snapshot",
      brand: { slug: "acme", css: snapshot().css, digest: "snapshot-digest" },
      warnings: [{ code: "brand-offline" }],
    });
    if (!resolution.ok) return;
    expect(resolution.warnings[0]?.message).toContain(".samva/brands/acme.json");
  });

  it("reads a named brand's snapshot for samva:brand/<slug>", async () => {
    const dir = await project();
    await writeSnapshot(dir, snapshot());
    await writeSnapshot(dir, snapshot({ slug: "promo", isDefault: false, digest: "promo" }));
    const resolution = await resolveProjectBrand({
      root: dir,
      files: { "theme.css": '@import "samva:brand/promo";' },
      themePath: "theme.css",
      env: { PATH: emptyPath },
    });
    expect(resolution).toMatchObject({ ok: true, brand: { slug: "promo", digest: "promo" } });
  });

  it("resolves the live default brand with SAMVA_API_KEY, without warnings when the snapshot matches", async () => {
    const dir = await project();
    await writeSnapshot(dir, snapshot({ digest: "live-digest" }));
    const api = await startApi([brandBody()]);
    try {
      const resolution = await resolveProjectBrand({
        root: dir,
        files: THEME,
        themePath: "theme.css",
        env: { PATH: emptyPath, SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url },
      });
      expect(resolution).toEqual({
        ok: true,
        source: "live",
        brand: {
          slug: "acme",
          css: brandBody().css,
          digest: "live-digest",
          assets: {},
          footer: { companyName: "Acme Inc." },
        },
        warnings: [],
      });
      expect(api.requests).toEqual([
        expect.objectContaining({
          url: "/v1/brands",
          headers: expect.objectContaining({ "x-api-key": "samva_sk_test_x" }),
        }),
      ]);
    } finally {
      await api.close();
    }
  });

  it("warns that the snapshot is stale when the live brand's digest differs", async () => {
    const dir = await project();
    await writeSnapshot(dir, snapshot());
    const api = await startApi([brandBody()]);
    try {
      const resolution = await resolveProjectBrand({
        root: dir,
        files: THEME,
        themePath: "theme.css",
        env: { PATH: emptyPath, SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url },
      });
      expect(resolution).toMatchObject({
        ok: true,
        source: "live",
        brand: { digest: "live-digest" },
        warnings: [{ code: "brand-snapshot-stale" }],
      });
      if (!resolution.ok) return;
      expect(resolution.warnings[0]?.message).toContain(".samva/brands/acme.json");
      // The live answer replaced the stale copy, so the next offline build matches it.
      const cached = JSON.parse(await readFile(join(dir, BRAND_SNAPSHOT_DIR, "acme.json"), "utf8"));
      expect(cached).toMatchObject({ version: 1, slug: "acme", digest: "live-digest" });
      const offline = await resolveProjectBrand({
        root: dir,
        files: THEME,
        themePath: "theme.css",
        env: { PATH: emptyPath },
      });
      expect(offline).toMatchObject({
        ok: true,
        source: "snapshot",
        brand: { digest: "live-digest" },
      });
    } finally {
      await api.close();
    }
  });

  it("caches the live brand in .samva/brands when there was no copy yet", async () => {
    const dir = await project();
    const api = await startApi([brandBody()]);
    try {
      const resolution = await resolveProjectBrand({
        root: dir,
        files: THEME,
        themePath: "theme.css",
        env: { PATH: emptyPath, SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url },
      });
      expect(resolution).toMatchObject({ ok: true, source: "live", warnings: [] });
      const cached = JSON.parse(await readFile(join(dir, BRAND_SNAPSHOT_DIR, "acme.json"), "utf8"));
      expect(cached).toMatchObject({
        version: 1,
        slug: "acme",
        name: "Acme",
        isDefault: true,
        css: brandBody().css,
        digest: "live-digest",
      });
      expect(typeof cached.pulledAt).toBe("string");
    } finally {
      await api.close();
    }
  });

  it("uses the cached copy without asking the API when offline", async () => {
    const dir = await project();
    await writeSnapshot(dir, snapshot());
    const api = await startApi([brandBody()]);
    try {
      const resolution = await resolveProjectBrand({
        root: dir,
        files: THEME,
        themePath: "theme.css",
        offline: true,
        env: { PATH: emptyPath, SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url },
      });
      expect(resolution).toMatchObject({
        ok: true,
        source: "snapshot",
        warnings: [{ code: "brand-offline" }],
      });
      expect(api.requests).toEqual([]);
    } finally {
      await api.close();
    }
  });

  it("still resolves the live brand when the cache cannot be written", async () => {
    const dir = await project();
    // A read-only cache directory makes the write fail.
    await mkdir(join(dir, BRAND_SNAPSHOT_DIR), { recursive: true });
    await chmod(join(dir, BRAND_SNAPSHOT_DIR), 0o500);
    const api = await startApi([brandBody()]);
    try {
      const resolution = await resolveProjectBrand({
        root: dir,
        files: THEME,
        themePath: "theme.css",
        env: { PATH: emptyPath, SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url },
      });
      expect(resolution).toMatchObject({ ok: true, source: "live" });
    } finally {
      await api.close();
    }
  });

  it("asks the samva CLI on PATH when there is no API key", async () => {
    const dir = await project();
    const bin = await mkdtemp(join(tmpdir(), "samva-brand-bin-"));
    try {
      const envelope = {
        schemaVersion: 1,
        type: "result",
        command: "brands.get",
        data: brandBody(),
      };
      const script = join(bin, "samva");
      await writeFile(
        script,
        // PATH holds only this directory, so the script uses shell builtins alone.
        `#!/bin/sh\n[ "$1 $2 $3 $4" = "brands get promo --json" ] || exit 9\nprintf '%s\\n' '${JSON.stringify({ ...envelope, data: brandBody({ slug: "promo", isDefault: false }) })}'\n`,
      );
      await chmod(script, 0o755);
      const resolution = await resolveProjectBrand({
        root: dir,
        files: { "emails/welcome.tsx": 'import { BrandFooter } from "samva:brand/promo";\n' },
        themePath: "theme.css",
        env: { PATH: bin },
      });
      expect(resolution).toMatchObject({ ok: true, source: "live", brand: { slug: "promo" } });
    } finally {
      await rm(bin, { recursive: true, force: true });
    }
  });

  it("fails loud, naming both fixes, when there is neither a live brand nor a snapshot", async () => {
    const resolution = await resolveProjectBrand({
      root: await project(),
      files: THEME,
      themePath: "theme.css",
      env: { PATH: emptyPath },
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.message).toContain("samva:brand");
    expect(resolution.message).toContain("samva login");
    expect(resolution.message).toContain("samva brands pull");
  });

  it("refuses a snapshot it cannot read instead of treating it as missing", async () => {
    const dir = await project();
    await mkdir(join(dir, BRAND_SNAPSHOT_DIR), { recursive: true });
    await writeFile(join(dir, BRAND_SNAPSHOT_DIR, "acme.json"), "{}");
    const resolution = await resolveProjectBrand({
      root: dir,
      files: THEME,
      themePath: "theme.css",
      env: { PATH: emptyPath },
    });
    expect(resolution).toMatchObject({ ok: false, message: expect.stringContaining("acme.json") });
  });
});
