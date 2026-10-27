import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest";

import { runCli } from "./support/run-cli";

// The project keeps entries under both roots, `templates/` and the older `emails/`.
// Process-level contract for a project with several entries: `add` registers an entry
// against the clone's project, and `publish --all` publishes every active entry at one
// commit through the real client seam against a local Git remote.

const PROJECT_ID = "tproj_2eqcmea000000000";
const WELCOME_ID = "tmpl_2eqcmea000000000";
const RESET_ID = "tmpl_4reset0000000000";
const DIGEST = "c".repeat(64);
const now = "2026-09-25T00:00:00.000Z";

const template = (id: string, slug: string) => ({
  id,
  namespaceId: null,
  shared: false,
  projectId: PROJECT_ID,
  entryPath: slug === "invitation" ? `emails/${slug}.tsx` : `templates/${slug}.tsx`,
  name: slug,
  slug,
  familyId: null,
  channel: "email",
  description: null,
  category: null,
  email: null,
  sms: null,
  whatsapp: null,
  publicationId: null,
  brand: null,
  inputContractId: null,
  inputSchema: null,
  usageCount: 0,
  lastUsedAt: null,
  status: "draft",
  isActive: true,
  publishedAt: null,
  fromDefault: null,
  replyToDefault: null,
  trackingDefault: null,
  createdAt: now,
  updatedAt: now,
});

const view = () => ({
  workspace: {
    projectId: PROJECT_ID,
    organizationId: "org_1234567890abcdefgh",
    ownerEpoch: 0,
    repositoryName: "template-2eqcmea",
    defaultBranch: "main",
    baseCommit: "a".repeat(40),
    remoteHead: "a".repeat(40),
    pendingRemoteHead: null,
    revision: "7",
    overlay: {},
    assetChanges: [],
    conflicts: [],
    provenance: { references: [] },
    mounts: [{ kind: "project", root: "/project", access: "read-write" }],
    libraryManifestDigest: DIGEST,
    createdAt: now,
    updatedAt: now,
    createdBy: { userId: "user_1234567890abcdef", via: "api" },
    updatedBy: { userId: "user_1234567890abcdef", via: "api" },
  },
  files: {},
});

const receipt = (templateId: string, commitSha: string, entryPath: string) => ({
  id: `tpub_${templateId.slice(5)}`,
  organizationId: "org_1234567890abcdefgh",
  projectId: PROJECT_ID,
  templateId,
  inputContractId: "tcon_2eqcmea000000000",
  commitSha,
  treeSha: DIGEST.slice(0, 40),
  entryPath,
  buildIdentity: DIGEST,
  manifest: {
    templateKey: entryPath,
    compiled: { version: 1, digest: DIGEST, bytes: 1024 },
    compiler: "@samva/markup@0.8.0",
    input: { schemaDigest: DIGEST, contractDigest: DIGEST },
    assets: { base: "https://cdn.samva.test", entries: [] },
    source: { commitSha, treeSha: DIGEST.slice(0, 40), entryPath, treeDigest: DIGEST },
  },
  compiled: { key: "publications/x", digest: DIGEST },
  assets: [],
  warnings: [],
  incompatibilities: [],
  status: "published",
  publishedAt: now,
  publishedBy: "user_1234567890abcdef",
  createdAt: now,
});

let server: Server;
let apiUrl = "";
let root = "";
let clone = "";
let head = "";
/** Entries whose publish the fake API refuses, as a build failure would. */
let failing = new Set<string>();
let localRepository = false;
let calls: Array<{ readonly route: string; readonly body: Record<string, unknown> }> = [];
let headers: Array<IncomingMessage["headers"]> = [];

const body = (request: IncomingMessage): Promise<string> =>
  new Promise((done) => {
    let text = "";
    request.on("data", (chunk) => (text += String(chunk)));
    request.on("end", () => done(text));
  });

const git = (args: ReadonlyArray<string>, cwd: string) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const write = async (path: string, text: string) => {
  await mkdir(dirname(join(clone, path)), { recursive: true });
  await writeFile(join(clone, path), text);
};

const cli = (args: ReadonlyArray<string>) =>
  runCli(args, {
    configHome: join(root, "config"),
    cwd: clone,
    env: {
      SAMVA_API_KEY: "samva_test_key",
      SAMVA_API_URL: apiUrl,
      ...(localRepository
        ? {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: `url.${join(root, "origin.git")}.insteadOf`,
            GIT_CONFIG_VALUE_0: "https://artifacts.test/samva/template.git",
          }
        : {}),
    },
  });

const entry = (id: string) => `export default defineTemplate({ id: "${id}" });\n`;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "samva-project-"));
  git(["init", "--quiet", "--bare", "--initial-branch=main", "origin.git"], root);
  git(["clone", "--quiet", "origin.git", "work"], root);
  clone = join(root, "work");
  git(["config", "user.email", "cli@samva.test"], clone);
  git(["config", "user.name", "Samva CLI test"], clone);
  await write("templates/welcome.tsx", entry("welcome"));
  await write("templates/reset.tsx", entry("reset"));
  await write("emails/invitation.tsx", entry("invitation"));
  await write("templates/components/layout.tsx", "export const Layout = () => null;\n");
  git(["add", "."], clone);
  git(["commit", "--quiet", "-m", "Account email"], clone);
  git(["push", "--quiet", "origin", "main"], clone);
  git(["config", "--local", "samva.projectId", PROJECT_ID], clone);
  head = git(["rev-parse", "HEAD"], clone);

  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const text = await body(request);
    const payload = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
    const route = `${request.method} ${url.pathname}`;
    calls.push({ route, body: payload });
    headers.push(request.headers);
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (route === "GET /v1/starters/") {
      return send(200, {
        items: [
          {
            id: "welcome",
            channel: "email",
            category: "transactional",
            name: "Welcome",
            description: "Welcome email",
            variables: [],
          },
          {
            id: "digest",
            channel: "email",
            category: "digest",
            name: "Digest",
            description: "Digest email",
            variables: [],
          },
          {
            id: "sms-alert",
            channel: "sms",
            category: "transactional",
            name: "Alert",
            description: "SMS alert",
            variables: [],
          },
        ],
      });
    }
    if (route === "POST /v1/templates") return send(201, template(WELCOME_ID, "welcome"));
    if (route === `GET /v1/templates/${WELCOME_ID}`)
      return send(200, template(WELCOME_ID, "welcome"));
    if (route === "GET /v1/templates" && url.searchParams.get("projectId") === PROJECT_ID) {
      return send(200, {
        items: [template(WELCOME_ID, "welcome"), template(RESET_ID, "reset")],
        nextCursor: null,
      });
    }
    if (route.startsWith("GET /v1/templates/") && url.pathname.endsWith("/repository")) {
      return send(200, {
        remote: "https://artifacts.test/samva/template.git",
        defaultBranch: "main",
      });
    }
    if (route.startsWith("POST /v1/templates/") && url.pathname.endsWith("/workspace")) {
      return send(200, view());
    }
    const published = /^POST \/v1\/templates\/(tmpl_\w+)\/publications$/.exec(route);
    if (published) {
      const entryPath = String(payload["entryPath"]);
      if (failing.has(entryPath)) {
        return send(409, {
          _tag: "ConflictError",
          resource: "TemplatePublication",
          message: `Email entry ${entryPath} does not exist at commit ${String(payload["commitSha"])}.`,
        });
      }
      return send(201, receipt(published[1]!, String(payload["commitSha"]), entryPath));
    }
    if (route === `POST /v1/templates/projects/${PROJECT_ID}/entries`) {
      return send(201, {
        ...template("tmpl_4nv4te0000000000", String(payload["slug"])),
        entryPath: payload["entryPath"],
        name: payload["name"],
      });
    }
    send(404, { _tag: "ResourceNotFoundError", resource: "Route", id: route, message: "no route" });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  failing = new Set();
  localRepository = false;
  calls = [];
  headers = [];
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  await rm(root, { recursive: true, force: true });
});

const data = <T>(stdout: string): T => (JSON.parse(stdout) as { readonly data: T }).data;

describe("samva templates publish --all", () => {
  it("publishes every active entry at one commit and names unregistered entries", async () => {
    const result = await cli(["templates", "publish", "--all", "--json"]);

    expect(result.code, result.stderr).toBe(0);
    expect(data(result.stdout)).toStrictEqual({
      action: "templates.publish",
      commitSha: head,
      publications: [
        {
          templateId: RESET_ID,
          slug: "reset",
          entryPath: "templates/reset.tsx",
          ok: true,
          publicationId: `tpub_${RESET_ID.slice(5)}`,
          status: "published",
        },
        {
          templateId: WELCOME_ID,
          slug: "welcome",
          entryPath: "templates/welcome.tsx",
          ok: true,
          publicationId: `tpub_${WELCOME_ID.slice(5)}`,
          status: "published",
        },
      ],
      unregistered: ["emails/invitation.tsx"],
    });
    const publishes = calls.filter(({ route }) => route.endsWith("/publications"));
    expect(publishes.map((call) => call.body)).toStrictEqual([
      {
        projectId: PROJECT_ID,
        commitSha: head,
        entryPath: "templates/reset.tsx",
        expectedWorkspaceRevision: "7",
      },
      {
        projectId: PROJECT_ID,
        commitSha: head,
        entryPath: "templates/welcome.tsx",
        expectedWorkspaceRevision: "7",
      },
    ]);
  });

  it("reports each entry and exits non-zero when one entry fails", async () => {
    failing = new Set(["templates/reset.tsx"]);

    const result = await cli(["templates", "publish", "--all", "--json"]);

    expect(result.code).not.toBe(0);
    const publications = data<{
      publications: ReadonlyArray<{ entryPath: string; ok: boolean }>;
    }>(result.stdout).publications;
    expect(publications.map(({ entryPath, ok }) => [entryPath, ok])).toStrictEqual([
      ["templates/reset.tsx", false],
      ["templates/welcome.tsx", true],
    ]);
  });

  it("requires an entry or --all when the project has several templates", async () => {
    const result = await cli(["templates", "publish"]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("has 2 active templates. Pass an entry path or --all.");
    expect(calls.some(({ route }) => route.endsWith("/publications"))).toBe(false);
  });

  it("publishes one named entry and refuses an unregistered one", async () => {
    const one = await cli(["templates", "publish", "templates/welcome.tsx", "--json"]);
    expect(one.code, one.stderr).toBe(0);
    expect(
      calls.filter(({ route }) => route.endsWith("/publications")).map(({ route }) => route),
    ).toStrictEqual([`POST /v1/templates/${WELCOME_ID}/publications`]);

    const unregistered = await cli(["templates", "publish", "emails/invitation.tsx"]);
    expect(unregistered.code).not.toBe(0);
    expect(unregistered.stderr).toContain("samva templates add emails/invitation.tsx");
  });
});

describe("samva templates add", () => {
  it("registers an entry against the clone's project", async () => {
    const result = await cli([
      "templates",
      "add",
      "emails/invitation.tsx",
      "--slug",
      "invitation",
      "--name",
      "Invitation",
      "--json",
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(calls.at(-1)).toStrictEqual({
      route: `POST /v1/templates/projects/${PROJECT_ID}/entries`,
      body: { entryPath: "emails/invitation.tsx", name: "Invitation", slug: "invitation" },
    });
  });

  it("refuses a path outside templates/ and emails/ before calling the API", async () => {
    const result = await cli(["templates", "add", "src/invitation.tsx", "--slug", "invitation"]);

    expect(result.code).not.toBe(0);
    expect(calls).toStrictEqual([]);
  });
});

describe("samva templates init --starter", () => {
  it("validates the email starter and sends it in the create request before cloning", async () => {
    localRepository = true;
    const destination = join(root, "starter-clone");
    const result = await cli([
      "templates",
      "init",
      "--name",
      "Welcome",
      "--starter",
      "welcome",
      "--dir",
      destination,
      "--json",
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(data(result.stdout)).toMatchObject({
      action: "templates.init",
      templateId: WELCOME_ID,
      dir: destination,
      commit: head,
    });
    expect(calls.slice(0, 2).map((call) => call.route)).toEqual([
      "GET /v1/starters/",
      "POST /v1/templates",
    ]);
    expect(calls[1]?.body).toMatchObject({ name: "Welcome", galleryTemplateId: "welcome" });
    expect(headers[0]?.["x-api-key"]).toBe("samva_test_key");
    expect(headers[0]?.["x-samva-client"]).toBe(headers[1]?.["x-samva-client"]);
    expect(headers[0]?.["x-samva-client"]).toMatch(/^cli\//);
  });

  it.each(["missing", "sms-alert"])(
    "refuses %s and lists email starter ids without creating",
    async (starter) => {
      const result = await cli([
        "templates",
        "init",
        "--name",
        "Welcome",
        "--starter",
        starter,
        "--json",
      ]);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("unknown_starter");
      expect(result.stderr).toContain(`Unknown email starter '${starter}'`);
      expect(result.stderr).toContain("Valid starter ids: welcome, digest.");
      expect(calls.map((call) => call.route)).toEqual(["GET /v1/starters/"]);
    },
  );
});
