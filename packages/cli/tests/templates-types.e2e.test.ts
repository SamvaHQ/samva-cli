import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";

// Never called: puts the spawned entry in this file's import graph for `vitest --changed`.
void (() => import("../src/bin.ts"));

// Process-level contract for `samva templates types`: what it writes, what it
// refuses, and the exit code an automation reads. The catalog is a real HTTP
// server so the command crosses the same client seam a customer's does.

const BIN = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const now = "2026-09-07T00:00:00.000Z";

const template = (input: {
  readonly slug: string;
  readonly id: string;
  readonly publicationId: string | null;
  readonly inputContractId: string | null;
  readonly inputSchema: Record<string, unknown> | null;
}) => ({
  id: input.id,
  namespaceId: null,
  shared: false,
  slug: input.slug,
  name: input.slug,
  channel: "email",
  projectId: "tproj_1234567890abcdef",
  entryPath: `templates/${input.slug}.tsx`,
  status: input.publicationId === null ? "draft" : "published",
  isActive: true,
  publishedAt: input.publicationId === null ? null : now,
  brand: null,
  fromDefault: null,
  usageCount: 0,
  lastUsedAt: null,
  createdAt: now,
  updatedAt: now,
  familyId: null,
  description: null,
  category: null,
  replyToDefault: null,
  trackingDefault: null,
  email: null,
  sms: null,
  whatsapp: null,
  publicationId: input.publicationId,
  inputContractId: input.inputContractId,
  inputSchema: input.inputSchema,
});

/** The list row of a template: no publication or input schema, which only its detail carries. */
const summary = ({
  familyId: _familyId,
  description: _description,
  category: _category,
  replyToDefault: _replyToDefault,
  trackingDefault: _trackingDefault,
  email: _email,
  sms: _sms,
  whatsapp: _whatsapp,
  publicationId: _publicationId,
  inputContractId: _inputContractId,
  inputSchema: _inputSchema,
  ...row
}: ReturnType<typeof template>) => row;

const welcomeSchema = {
  type: "object",
  properties: { firstName: { type: "string" } },
  required: ["firstName"],
  additionalProperties: false,
};

let server: Server;
let apiUrl = "";
let configHome = "";
let workspace = "";
/** Mutated between runs so a later `--check` sees a republished template. */
let publicationId = "tpub_2eqcmea000000000";

const runCli = (args: ReadonlyArray<string>): Promise<CliResult> =>
  new Promise((resolve, reject) => {
    const env = { ...process.env } as Record<string, string>;
    delete env["SAMVA_ORG"];
    delete env["SAMVA_PROFILE"];
    env["XDG_CONFIG_HOME"] = configHome;
    env["NO_COLOR"] = "1";
    env["SAMVA_API_KEY"] = "samva_test_key";
    env["SAMVA_API_URL"] = apiUrl;
    const child = spawn("bun", ["--no-env-file", BIN, ...args], {
      env,
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    child.stdin.end();
  });

const result = <T>(stdout: string): T => {
  const envelope = JSON.parse(stdout) as { readonly data: T };
  return envelope.data;
};

beforeAll(async () => {
  configHome = await mkdtemp(join(tmpdir(), "samva-types-config-"));
  workspace = await mkdtemp(join(tmpdir(), "samva-types-project-"));
  server = createServer((request, response) => {
    if (!request.url?.startsWith("/v1/templates")) {
      response.writeHead(404).end("{}");
      return;
    }
    const catalog = [
      template({
        slug: "welcome",
        id: "tmpl_2eqcmea000000000",
        publicationId,
        inputContractId: "tcon_2eqcmea000000000",
        inputSchema: welcomeSchema,
      }),
      template({
        slug: "draft-only",
        id: "tmpl_4qraft0000000000",
        publicationId: null,
        inputContractId: null,
        inputSchema: null,
      }),
    ];
    const path = new URL(request.url, "http://localhost").pathname;
    const detail = catalog.find((entry) => path === `/v1/templates/${entry.id}`);
    if (path !== "/v1/templates" && detail === undefined) {
      response.writeHead(404).end("{}");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        detail ?? {
          items: catalog.map(summary),
          nextCursor: null,
        },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(configHome, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

describe("samva templates types", () => {
  const out = () => join(workspace, "src", "samva-templates.ts");

  it("writes typed inputs pinned to each published template, and says what it skipped", async () => {
    const { code, stdout } = await runCli(["templates", "types", "--out", out(), "--json"]);
    expect(code).toBe(0);
    const data = result<{
      readonly written: boolean;
      readonly reference: string;
      readonly templates: readonly { readonly key: string; readonly reference: string }[];
      readonly skipped: readonly { readonly key: string; readonly reason: string }[];
    }>(stdout);
    expect(data).toMatchObject({
      written: true,
      reference: "exact",
      templates: [{ key: "welcome", reference: "tpub_2eqcmea000000000" }],
    });
    // A template with nothing to reference is named, not silently dropped.
    expect(data.skipped[0]).toMatchObject({ key: "draft-only" });
    const written = await readFile(out(), "utf8");
    expect(written).toContain("export type WelcomeInput");
    expect(written).toContain('publicationId: "tpub_2eqcmea000000000"');
  });

  it("reports no drift for the file it just wrote", async () => {
    const { code, stdout } = await runCli([
      "templates",
      "types",
      "--out",
      out(),
      "--check",
      "--json",
    ]);
    expect(code).toBe(0);
    expect(
      result<{ readonly ok: boolean; readonly drift: readonly unknown[] }>(stdout),
    ).toMatchObject({ ok: true, drift: [] });
  });

  it("exits 1 and names the template when the catalog moved ahead of the file", async () => {
    publicationId = "tpub_2eqcmea111111111";
    const { code, stdout } = await runCli([
      "templates",
      "types",
      "--out",
      out(),
      "--check",
      "--json",
    ]);
    publicationId = "tpub_2eqcmea000000000";
    expect(code).toBe(1);
    // A completed check that found drift is still a result: the report is the
    // point, and the exit code is what an automation branches on.
    const envelope = JSON.parse(stdout) as {
      readonly type: string;
      readonly data: { readonly ok: boolean; readonly drift: readonly { readonly key?: string }[] };
    };
    expect(envelope.type).toBe("result");
    expect(envelope.data.ok).toBe(false);
    expect(envelope.data.drift[0]).toMatchObject({ kind: "reference", key: "welcome" });
  });

  it("exits 1 when the file does not exist yet, and never writes under --check", async () => {
    const missing = join(workspace, "src", "absent.ts");
    const { code, stdout } = await runCli([
      "templates",
      "types",
      "--out",
      missing,
      "--check",
      "--json",
    ]);
    expect(code).toBe(1);
    expect(
      (JSON.parse(stdout) as { readonly data: { readonly drift: readonly { kind: string }[] } })
        .data.drift[0]?.kind,
    ).toBe("missing");
    await expect(readFile(missing, "utf8")).rejects.toThrow();
  });

  it("exits 1 when the generated file was edited by hand", async () => {
    await writeFile(out(), `${await readFile(out(), "utf8")}\n// hand edit\n`);
    const { code, stdout } = await runCli([
      "templates",
      "types",
      "--out",
      out(),
      "--check",
      "--json",
    ]);
    expect(code).toBe(1);
    expect(
      (JSON.parse(stdout) as { readonly data: { readonly drift: readonly { kind: string }[] } })
        .data.drift[0]?.kind,
    ).toBe("modified");
  });

  it("writes slug-keyed helpers that follow the input contract, and checks them", async () => {
    const bySlug = join(workspace, "src", "by-slug.ts");
    const written = await runCli(["templates", "types", "--by", "slug", "--out", bySlug, "--json"]);
    expect(written.code).toBe(0);
    expect(
      result<{
        readonly by: string;
        readonly templates: readonly { readonly key: string; readonly inputContractId: string }[];
      }>(written.stdout),
    ).toMatchObject({
      by: "slug",
      templates: [{ key: "welcome", inputContractId: "tcon_2eqcmea000000000" }],
    });
    expect(JSON.parse(written.stdout).data).not.toHaveProperty("reference");
    const human = await runCli(["templates", "types", "--by", "slug", "--out", bySlug]);
    expect(human.stdout).toMatch(/Publication\s+current/);
    expect(human.stdout).toMatch(/Drift\s+input contract/);
    expect(human.stdout).not.toContain("contract-latest");
    const source = await readFile(bySlug, "utf8");
    expect(source).toContain("templateSlug: slug");
    expect(source).not.toContain("tpub_");

    const upToDate = await runCli([
      "templates",
      "types",
      "--by",
      "slug",
      "--out",
      bySlug,
      "--check",
      "--json",
    ]);
    expect(upToDate.code).toBe(0);

    // The same file checked as id-keyed is behind: it was generated the other way.
    const asId = await runCli(["templates", "types", "--out", bySlug, "--check", "--json"]);
    expect(asId.code).toBe(1);
    expect(
      (
        JSON.parse(asId.stdout) as {
          readonly data: { readonly drift: readonly { kind: string }[] };
        }
      ).data.drift[0]?.kind,
    ).toBe("keying");
  });

  it("refuses --reference beside --by slug, which follows the current publication", async () => {
    const { code, stderr } = await runCli([
      "templates",
      "types",
      "--by",
      "slug",
      "--reference",
      "exact",
      "--out",
      out(),
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("--reference does not apply with --by slug");
  });

  it("refuses a reference kind it does not have", async () => {
    const { code, stderr } = await runCli([
      "templates",
      "types",
      "--out",
      out(),
      "--reference",
      "whatever",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("Use exact or contract-latest");
  });
});
