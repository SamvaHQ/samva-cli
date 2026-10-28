import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";

// Never called: puts the spawned entry in this file's import graph for `vitest --changed`.
void (() => import("../src/bin.ts"));

/**
 * The external CLI transport completing the authoring journey: open, patch,
 * check, render a declared fixture, save, publish. The API is a real HTTP
 * server holding the revision fence, so the journey crosses the same client
 * seam a customer's does and each step's output feeds the next.
 *
 * The recovery cases are the point of the fence: a stale revision, a source
 * that does not build, and a repeated request all have to be observable.
 */

const BIN = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const TEMPLATE_ID = "tmpl_2eqcmea000000000";
/** A template whose key may read the workspace but not open it. */
const READ_ONLY_ID = "tmpl_2eqcmeb000000000";
const SOURCE_REFUSED_ID = "tmpl_2eqcmec000000000";
const PROJECT_ID = "tproj_2eqcmea000000000";
const ENTRY = "templates/welcome.tsx";
const HEAD = "a".repeat(40);
const SAVED = "b".repeat(40);
const DIGEST = "c".repeat(64);
const sourceDiagnostics = [
  {
    code: "unsupported-element",
    severity: "error",
    message: "Use a supported email element.",
    origins: [{ fileName: ENTRY, lineNumber: 12, columnNumber: 3 }],
    notes: "Replace the unsupported element.",
    fixtures: ["basic"],
    occurrences: [[{ fileName: ENTRY, lineNumber: 12, columnNumber: 3 }]],
  },
] as const;

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

let server: Server;
let apiUrl = "";
let configHome = "";
let workspace = "";

/** The workspace the fake API holds: one revision fence and one file. */
let revision = 4;
let source = "export default function Welcome() {}";
/** Idempotency keys already answered, so a repeat returns the first answer. */
const answered = new Map<string, unknown>();
const calls: string[] = [];
/** Asset request bodies the fake API received, in order. */
const assetPayloads: Record<string, unknown>[] = [];
const assetKeys: Array<string | undefined> = [];

const view = () => ({
  workspace: {
    projectId: PROJECT_ID,
    organizationId: "org_1234567890abcdefgh",
    ownerEpoch: 0,
    repositoryName: "template-2eqcmea",
    defaultBranch: "main",
    baseCommit: HEAD,
    remoteHead: HEAD,
    pendingRemoteHead: null,
    revision: String(revision),
    overlay: { [ENTRY]: source },
    assetChanges: [],
    conflicts: [],
    provenance: { references: [] },
    mounts: [{ kind: "project", root: "/project", access: "read-write" }],
    libraryManifestDigest: DIGEST,
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
    createdBy: { userId: "user_1234567890abcdef", via: "api" },
    updatedBy: { userId: "user_1234567890abcdef", via: "api" },
  },
  files: { [ENTRY]: source },
});

/** A source that mentions `<a href="#">` stands in for one that does not build. */
const buildsCleanly = () => !source.includes("#broken");

const checkResult = () => ({
  projectId: PROJECT_ID,
  revision: String(revision),
  entryPath: ENTRY,
  declaration: buildsCleanly()
    ? {
        codeDigest: DIGEST,
        templateId: "welcome",
        input: {
          schema: { type: "object", properties: { firstName: { type: "string" } } },
          schemaDigest: DIGEST,
          contractDigest: DIGEST,
        },
        runtime: {},
        fixtures: ["basic"],
      }
    : null,
  diagnostics: buildsCleanly()
    ? []
    : [
        {
          code: "sml/build-failed",
          severity: "error",
          message: "Unexpected token in templates/welcome.tsx",
          origins: [],
        },
      ],
  incompatibilities: [],
});

const body = (request: IncomingMessage): Promise<string> =>
  new Promise((done) => {
    let text = "";
    request.on("data", (chunk) => (text += String(chunk)));
    request.on("end", () => done(text));
  });

const conflict = (message: string) => ({
  _tag: "ConflictError",
  message,
  resource: "TemplateProject",
});

const runCli = (args: ReadonlyArray<string>): Promise<CliResult> =>
  new Promise((done, fail) => {
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
    child.on("error", fail);
    child.on("close", (code) => done({ code: code ?? 0, stdout, stderr }));
    child.stdin.end();
  });

const data = <T>(stdout: string): T => (JSON.parse(stdout) as { readonly data: T }).data;

beforeAll(async () => {
  configHome = await mkdtemp(join(tmpdir(), "samva-ws-config-"));
  workspace = await mkdtemp(join(tmpdir(), "samva-ws-project-"));
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    calls.push(`${request.method} ${path}`);
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const payload = ["POST", "PATCH", "PUT"].includes(request.method ?? "")
      ? (JSON.parse((await body(request)) || "{}") as Record<string, unknown>)
      : {};
    const key = request.headers["idempotency-key"];
    const replay = typeof key === "string" ? answered.get(key) : undefined;
    if (replay !== undefined) return send(200, replay);
    const stale = (expected: unknown) =>
      typeof expected === "string" && expected !== String(revision);

    if (
      path === `/v1/templates/${SOURCE_REFUSED_ID}/workspace/save` ||
      path === `/v1/templates/${SOURCE_REFUSED_ID}/publications`
    )
      return send(422, {
        _tag: "TemplateSourceError",
        message: "Template source did not compile.",
        diagnostics: sourceDiagnostics,
      });

    if (path === `/v1/templates/${READ_ONLY_ID}/workspace` && request.method === "POST")
      return send(403, { _tag: "ForbiddenError", message: "Missing templates:create." });
    if (path === `/v1/templates/${READ_ONLY_ID}/workspace/check`) return send(200, checkResult());
    if (path === `/v1/templates/${TEMPLATE_ID}/workspace` && request.method === "POST")
      return send(200, view());
    if (path === `/v1/templates/${TEMPLATE_ID}/workspace` && request.method === "PATCH") {
      if (stale(payload["expectedRevision"]))
        return send(
          409,
          conflict(
            `Template workspace revision is ${revision}, not ${payload["expectedRevision"]}.`,
          ),
        );
      const patches: unknown = payload["patches"];
      if (Array.isArray(patches))
        for (const entry of patches)
          if (entry.path === ENTRY && typeof entry.content === "string") source = entry.content;
      revision += 1;
      const result = view();
      if (typeof key === "string") answered.set(key, result);
      return send(200, result);
    }
    if (path === `/v1/templates/${TEMPLATE_ID}/workspace/assets` && request.method === "PUT") {
      if (stale(payload["expectedRevision"]))
        return send(409, conflict("Template workspace moved."));
      assetPayloads.push(payload);
      assetKeys.push(typeof key === "string" ? key : undefined);
      revision += 1;
      const result = view();
      if (typeof key === "string") answered.set(key, result);
      return send(200, result);
    }
    if (path === `/v1/templates/${TEMPLATE_ID}/workspace/check`) {
      if (stale(payload["expectedRevision"]))
        return send(409, conflict("Template workspace moved."));
      return send(200, checkResult());
    }
    if (path === `/v1/templates/${TEMPLATE_ID}/workspace/fixtures`) {
      if (stale(payload["expectedRevision"]))
        return send(409, conflict("Template workspace moved."));
      return send(200, {
        ...checkResult(),
        fixture: payload["fixture"],
        rendered: buildsCleanly()
          ? {
              subject: "Welcome",
              html: '<p data-samva-instance="0.0">Ada</p>',
              text: "Ada",
              sentBytes: Buffer.byteLength("<p>Ada</p>"),
              previewBytes: Buffer.byteLength('<p data-samva-instance="0.0">Ada</p>'),
              selections: [
                {
                  instancePath: "0.0",
                  tag: "p",
                  origins: [{ fileName: "welcome.tsx", lineNumber: 3, columnNumber: 5 }],
                  authored: true,
                  occurrence: 1,
                  occurrences: 1,
                  parentPath: "0",
                  start: 0,
                  end: 38,
                },
              ],
            }
          : null,
      });
    }
    if (path === `/v1/templates/${TEMPLATE_ID}/workspace/save`) {
      if (stale(payload["expectedRevision"]))
        return send(409, conflict("Template workspace moved."));
      revision += 1;
      const receipt = {
        commit: SAVED,
        parentCommit: HEAD,
        tree: DIGEST.slice(0, 40),
        revision: String(revision),
        changedPaths: [ENTRY],
        sourceDigest: DIGEST,
        buildDigest: DIGEST,
        warnings: [],
        incompatibilities: [],
      };
      if (typeof key === "string") answered.set(key, receipt);
      return send(200, receipt);
    }
    if (path === `/v1/templates/${TEMPLATE_ID}/publications`) {
      if (stale(payload["expectedWorkspaceRevision"]))
        return send(409, conflict("Template workspace moved."));
      return send(201, {
        id: "tpub_2eqcmea000000000",
        organizationId: "org_1234567890abcdefgh",
        projectId: PROJECT_ID,
        templateId: TEMPLATE_ID,
        inputContractId: "tcon_2eqcmea000000000",
        commitSha: SAVED,
        treeSha: DIGEST.slice(0, 40),
        entryPath: ENTRY,
        buildIdentity: DIGEST,
        manifest: {
          templateKey: "welcome",
          compiled: { version: 1, digest: DIGEST, bytes: 1024 },
          compiler: "@samva/markup@0.8.0",
          input: { schemaDigest: DIGEST, contractDigest: DIGEST },
          assets: { base: "https://cdn.samva.test", entries: [] },
          source: {
            commitSha: SAVED,
            treeSha: DIGEST.slice(0, 40),
            entryPath: ENTRY,
            treeDigest: DIGEST,
          },
        },
        compiled: { key: "publications/x", digest: DIGEST },
        assets: [],
        warnings: [],
        incompatibilities: [],
        status: "published",
        publishedAt: "2026-09-07T00:00:00.000Z",
        publishedBy: "user_1234567890abcdef",
        createdAt: "2026-09-07T00:00:00.000Z",
      });
    }
    send(404, { _tag: "ResourceNotFoundError", resource: "Route", id: path, message: "no route" });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  await rm(configHome, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

describe("samva templates workspace", () => {
  it.each(["human", "--json", "--jsonl"])(
    "preserves a save's source refusal in %s output across the real HTTP client",
    async (mode) => {
      const result = await runCli([
        "templates",
        "workspace",
        "save",
        SOURCE_REFUSED_ID,
        "--revision",
        "4",
        "--head",
        HEAD,
        "--message",
        "Save welcome",
        "--idempotency-key",
        `source-refused-${mode}`,
        ...(mode === "human" ? [] : [mode]),
      ]);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      if (mode === "human") {
        expect(result.stderr).toContain("✗ Template source did not compile.");
        expect(result.stderr).toContain(
          "templates/welcome.tsx:12:3 error unsupported-element: Use a supported email element.",
        );
        expect(result.stderr).toContain(
          "Try: Fix the template source at the listed diagnostics, then save again.",
        );
      } else {
        expect(JSON.parse(result.stderr)).toEqual({
          schemaVersion: 1,
          type: "error",
          command: "templates.workspace.save",
          reason: "TemplateSourceError",
          message: "Template source did not compile.",
          status: 422,
          details: { diagnostics: sourceDiagnostics },
          next: "Fix the template source at the listed diagnostics, then save again.",
        });
        if (mode === "--jsonl") expect(result.stderr.trim().split("\n")).toHaveLength(1);
      }
    },
  );

  it("preserves a publication's source refusal across the real HTTP client", async () => {
    const result = await runCli([
      "templates",
      "workspace",
      "publish",
      SOURCE_REFUSED_ID,
      "--revision",
      "4",
      "--commit",
      HEAD,
      "--entry",
      ENTRY,
      "--project-id",
      PROJECT_ID,
      "--json",
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      reason: "TemplateSourceError",
      status: 422,
      details: { diagnostics: sourceDiagnostics },
      next: "Fix the template source at the listed diagnostics, then save again.",
    });
  });

  it("completes edit, check, fixture, save and publish against the shared operations", async () => {
    const edited = join(workspace, "welcome.tsx");
    await writeFile(edited, "export default function Welcome() { return <p>Ada</p> }");

    const opened = await runCli(["templates", "workspace", "open", TEMPLATE_ID, "--json"]);
    expect(opened.stderr).toBe("");
    expect(opened.code).toBe(0);
    const at = data<{ workspace: { revision: string; remoteHead: string } }>(opened.stdout);
    expect(at.workspace.revision).toBe("4");

    const patched = await runCli([
      "templates",
      "workspace",
      "patch",
      TEMPLATE_ID,
      "--revision",
      at.workspace.revision,
      "--set",
      `${ENTRY}=${edited}`,
      "--idempotency-key",
      "journey-edit-1",
      "--json",
    ]);
    expect(patched.code).toBe(0);
    const afterEdit = data<{ workspace: { revision: string } }>(patched.stdout);
    expect(afterEdit.workspace.revision).toBe("5");

    const checked = await runCli([
      "templates",
      "workspace",
      "check",
      TEMPLATE_ID,
      "--revision",
      afterEdit.workspace.revision,
      "--json",
    ]);
    expect(checked.code).toBe(0);
    const declaration = data<{
      declaration: { templateId: string; fixtures: readonly string[] } | null;
    }>(checked.stdout).declaration;
    // The check names the fixture the next call renders.
    expect(declaration).toMatchObject({ templateId: "welcome", fixtures: ["basic"] });

    const rendered = await runCli([
      "templates",
      "workspace",
      "fixture",
      TEMPLATE_ID,
      "--revision",
      afterEdit.workspace.revision,
      "--name",
      declaration?.fixtures[0] ?? "",
      "--json",
    ]);
    expect(rendered.code).toBe(0);
    expect(data<{ rendered: { subject: string } | null }>(rendered.stdout).rendered).toMatchObject({
      subject: "Welcome",
    });

    const saved = await runCli([
      "templates",
      "workspace",
      "save",
      TEMPLATE_ID,
      "--revision",
      afterEdit.workspace.revision,
      "--head",
      at.workspace.remoteHead,
      "--message",
      "Update welcome",
      "--idempotency-key",
      "journey-save-1",
      "--json",
    ]);
    expect(saved.code).toBe(0);
    const receipt = data<{ commit: string; revision: string }>(saved.stdout);
    expect(receipt.commit).toBe(SAVED);

    const published = await runCli([
      "templates",
      "workspace",
      "publish",
      TEMPLATE_ID,
      "--revision",
      receipt.revision,
      "--commit",
      receipt.commit,
      "--entry",
      ENTRY,
      "--project-id",
      PROJECT_ID,
      "--json",
    ]);
    expect(published.code).toBe(0);
    expect(data<{ commitSha: string; status: string }>(published.stdout)).toMatchObject({
      commitSha: SAVED,
      status: "published",
    });

    // Every step crossed the API; none of them needed a Git clone.
    expect(calls).toContain(`POST /v1/templates/${TEMPLATE_ID}/workspace/check`);
    expect(calls).toContain(`POST /v1/templates/${TEMPLATE_ID}/publications`);
  });

  it("sends a local image as base64 at assets/<file name> unless a path is named", async () => {
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    await writeFile(join(workspace, "logo.png"), image);

    const added = await runCli([
      "templates",
      "workspace",
      "add-asset",
      TEMPLATE_ID,
      "logo.png",
      "--revision",
      String(revision),
      "--idempotency-key",
      "asset-add-1",
      "--json",
    ]);
    expect(added.stderr).toBe("");
    expect(added.code).toBe(0);
    const afterAdd = data<{ workspace: { revision: string } }>(added.stdout);

    const replaced = await runCli([
      "templates",
      "workspace",
      "add-asset",
      TEMPLATE_ID,
      "logo.png",
      "--path",
      "assets/brand/logo.png",
      "--replace",
      "--revision",
      afterAdd.workspace.revision,
      "--idempotency-key",
      "asset-replace-1",
      "--json",
    ]);
    expect(replaced.code).toBe(0);

    expect(assetKeys.slice(-2)).toEqual(["asset-add-1", "asset-replace-1"]);
    expect(assetPayloads.slice(-2)).toEqual([
      {
        expectedRevision: String(Number(afterAdd.workspace.revision) - 1),
        path: "assets/logo.png",
        contentBase64: image.toString("base64"),
        replace: false,
      },
      {
        expectedRevision: afterAdd.workspace.revision,
        path: "assets/brand/logo.png",
        contentBase64: image.toString("base64"),
        replace: true,
      },
    ]);
  });

  it("refuses an unreadable local asset before calling the API", async () => {
    const before = assetPayloads.length;
    const result = await runCli([
      "templates",
      "workspace",
      "add-asset",
      TEMPLATE_ID,
      "missing.png",
      "--revision",
      String(revision),
      "--idempotency-key",
      "asset-missing-1",
      "--json",
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      type: "error",
      message: expect.stringContaining("missing.png"),
    });
    expect(assetPayloads).toHaveLength(before);
  });

  it("returns the first answer to a repeated request rather than editing twice", async () => {
    const edited = join(workspace, "repeat.tsx");
    await writeFile(edited, "export default function Welcome() { return <p>Repeat</p> }");
    const before = revision;
    const args = [
      "templates",
      "workspace",
      "patch",
      TEMPLATE_ID,
      "--revision",
      String(before),
      "--set",
      `${ENTRY}=${edited}`,
      "--idempotency-key",
      "repeat-1",
      "--json",
    ];
    const first = await runCli(args);
    const second = await runCli(args);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    // One edit happened, not two: the revision advanced once.
    expect(revision).toBe(before + 1);
  });

  it("refuses every fenced operation at a revision the workspace has moved past", async () => {
    const stale = "1";
    for (const args of [
      ["templates", "workspace", "check", TEMPLATE_ID, "--revision", stale],
      ["templates", "workspace", "fixture", TEMPLATE_ID, "--revision", stale, "--name", "basic"],
      [
        "templates",
        "workspace",
        "save",
        TEMPLATE_ID,
        "--revision",
        stale,
        "--head",
        HEAD,
        "--message",
        "no",
        "--idempotency-key",
        `stale-${stale}-${Math.random()}`,
      ],
    ]) {
      const result = await runCli([...args, "--json"]);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({
        type: "error",
        reason: "ConflictError",
        status: 409,
        message: expect.stringContaining("Template workspace"),
        next: "Read the resource and resolve the conflict before retrying.",
      });
    }
  });

  it("reports a source that does not build as findings, not as a failed call", async () => {
    const broken = join(workspace, "broken.tsx");
    await writeFile(broken, 'export default function Welcome() { return <a href="#broken" /> }');
    const patched = await runCli([
      "templates",
      "workspace",
      "patch",
      TEMPLATE_ID,
      "--revision",
      String(revision),
      "--set",
      `${ENTRY}=${broken}`,
      "--idempotency-key",
      "broken-1",
      "--json",
    ]);
    expect(patched.code).toBe(0);

    const checked = await runCli([
      "templates",
      "workspace",
      "check",
      TEMPLATE_ID,
      "--revision",
      String(revision),
      "--json",
    ]);
    // The call succeeded; the source did not. That distinction is what lets an
    // agent read the finding and patch again instead of retrying the call.
    expect(checked.code).toBe(0);
    expect(
      data<{
        declaration: unknown;
        diagnostics: readonly { code: string; severity: string }[];
      }>(checked.stdout),
    ).toMatchObject({
      declaration: null,
      diagnostics: [{ code: "sml/build-failed", severity: "error" }],
    });

    const rendered = await runCli([
      "templates",
      "workspace",
      "fixture",
      TEMPLATE_ID,
      "--revision",
      String(revision),
      "--name",
      "basic",
      "--json",
    ]);
    expect(rendered.code).toBe(0);
    expect(data<{ rendered: unknown }>(rendered.stdout).rendered).toBeNull();
  });

  it("fences check and fixture to the workspace's current revision when --revision is omitted", async () => {
    calls.length = 0;
    const checked = await runCli(["templates", "workspace", "check", TEMPLATE_ID, "--json"]);
    expect(checked.stderr).toBe("");
    expect(checked.code).toBe(0);
    expect(data<{ revision: string }>(checked.stdout).revision).toBe(String(revision));

    const rendered = await runCli([
      "templates",
      "workspace",
      "fixture",
      TEMPLATE_ID,
      "--name",
      "basic",
      "--json",
    ]);
    expect(rendered.stderr).toBe("");
    expect(rendered.code).toBe(0);
    expect(calls).toEqual([
      `POST /v1/templates/${TEMPLATE_ID}/workspace`,
      `POST /v1/templates/${TEMPLATE_ID}/workspace/check`,
      `POST /v1/templates/${TEMPLATE_ID}/workspace`,
      `POST /v1/templates/${TEMPLATE_ID}/workspace/fixtures`,
    ]);
  });

  it("tells a key that cannot open the workspace to pass --revision", async () => {
    const withoutRevision = await runCli([
      "templates",
      "workspace",
      "check",
      READ_ONLY_ID,
      "--json",
    ]);
    expect(withoutRevision.code).toBe(4);
    expect(JSON.parse(withoutRevision.stderr).message).toContain("pass --revision to skip that");

    const withRevision = await runCli([
      "templates",
      "workspace",
      "check",
      READ_ONLY_ID,
      "--revision",
      String(revision),
      "--json",
    ]);
    expect(withRevision.code).toBe(0);
  });

  it("refuses a patch that names nothing to change", async () => {
    const result = await runCli([
      "templates",
      "workspace",
      "patch",
      TEMPLATE_ID,
      "--revision",
      String(revision),
      "--idempotency-key",
      "empty-1",
      "--json",
    ]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ reason: "empty_patch" });
  });
});
