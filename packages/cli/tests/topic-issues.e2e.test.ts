import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { runCli } from "./support/run-cli";

const ID = "unsub_1234567890abcdef";
const PROJECT = "tproj_1234567890abcdef";
const PATH = "issues/october.md";
const HEAD = "a".repeat(40);
const CONTENT = "---\nsubject: October\n---\n# October\n";
const document = { projectId: PROJECT, revision: "4", path: PATH, content: CONTENT };
const draft = {
  workspace: {
    projectId: PROJECT,
    organizationId: "org_1234567890abcdef",
    ownerEpoch: 0,
    repositoryName: "template-topic",
    defaultBranch: "main",
    baseCommit: HEAD,
    remoteHead: HEAD,
    pendingRemoteHead: null,
    revision: "5",
    overlay: {},
    assetChanges: [],
    conflicts: [],
    provenance: { references: [] },
    mounts: [{ kind: "project", root: "/project", access: "read-write" }],
    libraryManifestDigest: "b".repeat(64),
    createdAt: "2026-10-26T00:00:00Z",
    updatedAt: "2026-10-26T00:00:00Z",
    createdBy: { userId: "user_1234567890abcdef", via: "api" },
    updatedBy: { userId: "user_1234567890abcdef", via: "api" },
  },
  files: { [PATH]: CONTENT },
};
const check = {
  projectId: PROJECT,
  revision: "4",
  entryPath: PATH,
  declaration: null,
  diagnostics: [],
  incompatibilities: [],
};
let configHome: string;
beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), "samva-issues-"));
});
afterEach(async () => {
  await rm(configHome, { recursive: true, force: true });
});

const startApi = async (
  failure?: { status: number; body: unknown },
  listItems: ReadonlyArray<unknown> = [{ path: PATH, title: "October", latestSend: null }],
) => {
  const requests: Array<{
    method: string;
    path: string;
    body: unknown;
    key: string | string[] | undefined;
  }> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url ?? "/", "http://test");
    requests.push({
      method: req.method ?? "GET",
      path: req.url ?? "/",
      body: body ? JSON.parse(body) : null,
      key: req.headers["x-api-key"],
    });
    let response: unknown = draft;
    if (url.pathname.endsWith("/document")) response = document;
    else if (url.pathname.endsWith("/head"))
      response = { projectId: PROJECT, revision: "4", remoteHead: HEAD };
    else if (url.pathname.endsWith("/history"))
      response = { projectId: PROJECT, head: HEAD, commits: [] };
    else if (url.pathname.endsWith("/check")) response = check;
    else if (url.pathname.endsWith("/render"))
      response = { ...check, fixture: "default", rendered: null, whatsapp: null, page: null };
    else if (url.pathname.endsWith("/save"))
      response = {
        commit: HEAD,
        parentCommit: HEAD,
        tree: HEAD,
        revision: "5",
        changedPaths: [PATH],
        sourceDigest: "b".repeat(64),
        buildDigest: "c".repeat(64),
        warnings: [],
        incompatibilities: [],
      };
    else if (req.method === "GET" && url.pathname.endsWith("/issues"))
      response = { projectId: PROJECT, revision: "4", items: listItems };
    res.writeHead(failure?.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(failure?.body ?? response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Test API did not bind");
  return {
    requests,
    env: {
      SAMVA_API_KEY: "samva_sk_test_issues",
      SAMVA_API_URL: `http://127.0.0.1:${address.port}`,
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
const base = `/v1/topics/${ID}/issues`;

describe("topic issue CLI subprocess contract", () => {
  it("forwards every curated issue operation and emits one complete result envelope", async () => {
    const api = await startApi();
    const file = join(configHome, "issue.md");
    await writeFile(file, CONTENT);
    try {
      const commands = [
        ["list"],
        ["open"],
        ["head"],
        ["history", "--limit", "8"],
        ["read", "--path", PATH, "--revision", "4"],
        ["create", "--path", PATH, "--file", file, "--idempotency-key", "create-1"],
        ["update", "--path", PATH, "--file", "-", "--revision", "4", "--idempotency-key", "edit-1"],
        ["delete", "--path", PATH, "--revision", "4", "--idempotency-key", "delete-1", "--yes"],
        [
          "save",
          "--revision",
          "4",
          "--head",
          HEAD,
          "--message",
          "Save issue",
          "--idempotency-key",
          "save-1",
        ],
        ["check", "--path", PATH, "--revision", "4"],
        ...["email", "web"].map((target) => [
          "render",
          "--path",
          PATH,
          "--revision",
          "4",
          "--fixture",
          "default",
          "--target",
          target,
        ]),
      ];
      for (const [name, ...flags] of commands) {
        const result = await runCli(
          ["topics", "issues", name!, ID, ...flags, "--json", "--log-level", "debug"],
          { configHome, env: api.env, stdin: CONTENT },
        );
        expect(result.code, result.stderr).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toMatchObject({
          schemaVersion: 1,
          type: "result",
          command: `topics.issues.${name}`,
        });
      }
      expect(api.requests.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
        { method: "GET", path: base, body: null },
        { method: "GET", path: `${base}/workspace`, body: null },
        { method: "GET", path: `${base}/head`, body: null },
        { method: "GET", path: `${base}/history?limit=8`, body: null },
        {
          method: "GET",
          path: `${base}/document?path=issues%2Foctober.md&expectedRevision=4`,
          body: null,
        },
        {
          method: "POST",
          path: base,
          body: { path: PATH, content: CONTENT, idempotencyKey: "create-1" },
        },
        {
          method: "PATCH",
          path: base,
          body: { path: PATH, content: CONTENT, expectedRevision: "4", idempotencyKey: "edit-1" },
        },
        {
          method: "POST",
          path: `${base}/remove`,
          body: { path: PATH, expectedRevision: "4", idempotencyKey: "delete-1" },
        },
        {
          method: "POST",
          path: `${base}/save`,
          body: {
            expectedRevision: "4",
            expectedHead: HEAD,
            message: "Save issue",
            idempotencyKey: "save-1",
          },
        },
        { method: "POST", path: `${base}/check`, body: { path: PATH, expectedRevision: "4" } },
        ...["email", "web"].map((target) => ({
          method: "POST",
          path: `${base}/render`,
          body: { path: PATH, expectedRevision: "4", fixture: "default", target },
        })),
      ]);
      expect(api.requests.every(({ key }) => key === "samva_sk_test_issues")).toBe(true);
      const human = await runCli(
        ["topics", "issues", "read", ID, "--path", PATH, "--revision", "4"],
        { configHome, env: api.env },
      );
      expect(human.code, human.stderr).toBe(0);
      expect(JSON.parse(human.stdout)).toEqual(document);
    } finally {
      await api.close();
    }
  }, 30000);

  it("lists each issue's title and send status in human mode and the raw response in JSON", async () => {
    const run = {
      id: "crun_1234567890abcdef",
      status: "scheduled",
      scheduledFor: "2026-10-28T00:00:00.000Z",
      completedAt: null,
      totalRecipients: 0,
      dispatchedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      pendingCount: 0,
      estimatedCompletionAt: null,
    };
    const items = [
      { path: "issues/august.md", title: null, latestSend: null },
      {
        path: PATH,
        title: "October",
        latestSend: { campaignId: "camp_1234567890abcdef", run },
      },
    ];
    const api = await startApi(undefined, items);
    try {
      const human = await runCli(["topics", "issues", "list", ID], { configHome, env: api.env });
      expect(human.code, human.stderr).toBe(0);
      expect(human.stdout.trimEnd().split("\n")).toEqual([
        "Revision 4",
        "issues/august.md   (no title)  [draft]",
        "issues/october.md  October  [scheduled]",
      ]);
      const json = await runCli(["topics", "issues", "list", ID, "--json"], {
        configHome,
        env: api.env,
      });
      expect(json.code, json.stderr).toBe(0);
      expect(JSON.parse(json.stdout).data).toEqual({ projectId: PROJECT, revision: "4", items });
    } finally {
      await api.close();
    }
  }, 30000);

  it("previews writes without requests and requires a deletion confirmation outside a terminal", async () => {
    const api = await startApi();
    try {
      const result = await runCli(
        [
          "topics",
          "issues",
          "update",
          ID,
          "--path",
          PATH,
          "--file",
          "-",
          "--revision",
          "4",
          "--idempotency-key",
          "edit-1",
          "--dry-run",
          "--json",
        ],
        { configHome, env: api.env, stdin: CONTENT },
      );
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).data).toEqual({
        dryRun: true,
        action: "topicIssues.update",
        request: {
          id: ID,
          path: PATH,
          content: CONTENT,
          expectedRevision: "4",
          idempotencyKey: "edit-1",
        },
      });
      const args = [
        "topics",
        "issues",
        "delete",
        ID,
        "--path",
        PATH,
        "--revision",
        "4",
        "--idempotency-key",
        "delete-1",
        "--json",
      ];
      expect((await runCli([...args, "--dry-run"], { configHome, env: api.env })).code).toBe(0);
      const refused = await runCli(args, { configHome, env: api.env });
      expect(refused.code).not.toBe(0);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("--yes");
      expect(api.requests).toEqual([]);
    } finally {
      await api.close();
    }
  });

  it.each([
    [409, { _tag: "ConflictError", message: "Workspace moved", resource: "TopicIssue", id: ID }],
    [403, { _tag: "ForbiddenError", message: "Topic belongs to another namespace" }],
    [403, { _tag: "FlagDisabledError", message: "Issues disabled", flag: "issueContent" }],
  ])("preserves upstream failure %s and exits nonzero", async (status, body) => {
    const api = await startApi({ status, body });
    try {
      const result = await runCli(
        ["topics", "issues", "read", ID, "--path", PATH, "--revision", "4", "--json"],
        { configHome, env: api.env },
      );
      expect(result.code).toBe(status === 403 ? 4 : 1);
      expect(result.stdout).toBe("");
      const { _tag, message, ...details } = body;
      expect(JSON.parse(result.stderr)).toMatchObject({
        type: "error",
        reason: _tag,
        status,
        message: expect.stringContaining(message),
        details,
      });
    } finally {
      await api.close();
    }
  });

  it("rejects missing revision fences before any API request and documents every command", async () => {
    const api = await startApi();
    try {
      for (const name of ["read", "update", "delete", "save", "check", "render"]) {
        const result = await runCli(["topics", "issues", name, ID, "--path", PATH, "--json"], {
          configHome,
          env: api.env,
        });
        expect(result.code).toBe(2);
      }
      expect(api.requests).toEqual([]);
      for (const name of [
        "list",
        "open",
        "read",
        "create",
        "update",
        "delete",
        "save",
        "check",
        "render",
        "head",
        "history",
      ]) {
        const help = await runCli(["topics", "issues", name, "--help", "--json"], { configHome });
        expect(help.code, help.stderr).toBe(0);
        expect(JSON.parse(help.stdout).data.examples.length).toBeGreaterThan(0);
      }
    } finally {
      await api.close();
    }
  }, 30000);
});
