import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { IMPORT_REQUEST_MAX_BYTES } from "@samva/core/contacts/import-job";

import { runCli } from "./support/run-cli";

const topic = "unsub_7q2xk9mvt4znw8rh";
const jobId = "cimport_7q2xk9mvt4znw8rh";
const counts = {
  totalRows: 2,
  uniqueAddresses: 2,
  subscribed: 1,
  unsubscribed: 0,
  suppressed: 1,
  skipped: 0,
  conflicts: 0,
  created: 2,
  existing: 0,
};
const plan = {
  planHash: "a".repeat(64),
  presetVersion: "1",
  namespaceId: null,
  topicId: topic,
  canStart: true,
  counts,
  diagnostics: [],
  diagnosticsTruncated: false,
};
const now = "2026-10-25T00:00:00.000Z";
const job = {
  id: jobId,
  namespaceId: null,
  topicId: topic,
  preset: "mailchimp",
  status: "queued",
  generation: 1,
  counts,
  processedRows: 0,
  totalRows: 2,
  createdAt: now,
  startedAt: null,
  updatedAt: now,
  completedAt: null,
  failure: null,
  resumable: false,
};

let directory: string;
let apiUrl: string;
let close: () => Promise<void>;
let requests: Array<{ path: string; body: unknown; idempotencyKey: unknown }>;
let refuse: boolean;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "samva-import-cli-"));
  await writeFile(join(directory, "readers.csv"), "Email Address\nreader@example.test\n");
  await writeFile(join(directory, "cleaned.csv"), "Email Address\nbounce@example.test\n");
  requests = [];
  refuse = false;
  const server = createServer(async (req, res) => {
    let source = "";
    for await (const chunk of req) source += String(chunk);
    const path = req.url ?? "";
    requests.push({
      path,
      body: source ? JSON.parse(source) : null,
      idempotencyKey: req.headers["idempotency-key"],
    });
    res.writeHead(path.endsWith("/plan") ? 200 : path.endsWith("/imports") ? 202 : 200, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify(path.endsWith("/plan") ? { ...plan, canStart: !refuse } : job));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No test API port");
  apiUrl = `http://127.0.0.1:${address.port}`;
  close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

afterEach(async () => {
  await close();
  await rm(directory, { recursive: true, force: true });
});

const cli = (args: string[]) =>
  runCli(["contacts", ...args], {
    configHome: directory,
    cwd: directory,
    env: { SAMVA_API_KEY: "samva_sk_test_import", SAMVA_API_URL: apiUrl },
  });
const inputArgs = () => [
  "import",
  "--preset",
  "mailchimp",
  "--topic",
  topic,
  "--file",
  `subscribed=${join(directory, "readers.csv")}`,
  "--file",
  `cleaned/bounced=${join(directory, "cleaned.csv")}`,
];

describe("list migration CLI HTTP boundary", () => {
  it("rejects an oversized encoded preview without contacting the API", async () => {
    await writeFile(join(directory, "readers.csv"), "é".repeat(IMPORT_REQUEST_MAX_BYTES / 2));
    const result = await cli([...inputArgs(), "--dry-run", "--json"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/encoded import request/i);
    expect(requests).toEqual([]);
  });

  it("rejects a start whose envelope exceeds the budget after a valid preview", async () => {
    plan.planHash = "x".repeat(IMPORT_REQUEST_MAX_BYTES);
    try {
      const result = await cli([...inputArgs(), "--idempotency-key", "migration-1", "--json"]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/encoded import request/i);
      expect(requests.map((request) => request.path)).toEqual(["/v1/contacts/imports/plan"]);
    } finally {
      plan.planHash = "a".repeat(64);
    }
  });
  it("dry-run only previews and forwards each file's declared evidence", async () => {
    const result = await cli([...inputArgs(), "--dry-run", "--json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      type: "result",
      data: plan,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      path: "/v1/contacts/imports/plan",
      body: {
        preset: "mailchimp",
        topicId: topic,
        files: [
          { name: "readers.csv", evidence: { kind: "export_scope", scope: "subscribed" } },
          { name: "cleaned.csv", evidence: { kind: "export_scope", scope: "cleaned/bounced" } },
        ],
      },
    });
  });

  it("starts with the returned preview hash and explicit retry key", async () => {
    const result = await cli([...inputArgs(), "--idempotency-key", "migration-1", "--json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      path: "/v1/contacts/imports",
      body: { mode: "new", planHash: plan.planHash },
      idempotencyKey: "migration-1",
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ data: { id: jobId, status: "queued" } });
  });

  it("replays a reviewed submission without requiring the preview endpoint", async () => {
    refuse = true;
    const result = await cli([
      ...inputArgs(),
      "--idempotency-key",
      "migration-1",
      "--plan-hash",
      plan.planHash,
      "--json",
    ]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      path: "/v1/contacts/imports",
      body: { mode: "new", planHash: plan.planHash },
      idempotencyKey: "migration-1",
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ data: { id: jobId } });
  });

  it("refuses combining a saved preview hash with dry-run", async () => {
    const result = await cli([...inputArgs(), "--plan-hash", plan.planHash, "--dry-run", "--json"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("import_plan_hash_with_dry_run");
    expect(requests).toHaveLength(0);
  });

  it("refuses apply without a retry key before contacting the API", async () => {
    const result = await cli([...inputArgs(), "--json"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(requests).toHaveLength(0);
  });

  it("refuses a blocked plan without starting", async () => {
    refuse = true;
    const result = await cli([...inputArgs(), "--idempotency-key", "migration-1", "--json"]);
    expect(result.code).toBe(2);
    expect(requests).toHaveLength(1);
    expect(result.stderr).toContain("import_plan_refused");
  });

  it("requires evidence rather than inferring subscribed from the filename", async () => {
    const result = await cli([
      "import",
      "--preset",
      "mailchimp",
      "--topic",
      topic,
      "--file",
      join(directory, "readers.csv"),
      "--dry-run",
      "--json",
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("import_file_evidence_required");
    expect(requests).toHaveLength(0);
  });

  it("reads progress and resumes only the requested generation", async () => {
    const status = await cli(["import-status", jobId, "--json"]);
    expect(status).toMatchObject({ code: 0, stderr: "" });
    expect(requests[0]?.path).toBe(`/v1/contacts/imports/${jobId}`);
    const resume = await cli(["import-resume", jobId, "--generation", "1", "--json"]);
    expect(resume).toMatchObject({ code: 0, stderr: "" });
    expect(requests[1]).toMatchObject({
      path: "/v1/contacts/imports",
      body: { mode: "resume", jobId, expectedGeneration: 1 },
    });
  });
});
