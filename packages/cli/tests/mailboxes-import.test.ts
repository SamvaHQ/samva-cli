import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { maxArchiveSizeBytes, maxImportSizeBytes } from "@samva/core/mailboxes/history-import";

import { createTestServer } from "./support/http-server";
import { runCli } from "./support/run-cli";

const mailboxId = "mbx_1234567890123456";
const importPath = `/v1/mailboxes/${mailboxId}/imports/mimport_aaaaaaaaaaaaaaa1`;
const archiveId = (index: number) => `e329e0f7-82f7-4656-9410-${String(index).padStart(12, "0")}`;
const archivePath = (index: number) => `${importPath}/uploads/${archiveId(index)}`;
const partPath = (index: number, partNumber: number) =>
  `/archive/${index}/${partNumber}?signature=synthetic-private-token`;
const now = "2026-11-15T00:00:00.000Z";
const mime =
  "From sender@example.test Sat Nov 14 12:00:00 2026\nMessage-ID: <fixture@example.test>\nFrom: sender@example.test\nTo: owner@example.test\nX-Gmail-Labels: Inbox,Unread,Clients\nSubject: History fixture\n\nHello.\n";
let directory: string;
let apiUrl: string;
let close: () => Promise<void>;
let requests: Array<{
  method: string;
  path: string;
  body: string;
  key: unknown;
  authorization: unknown;
  contentLength: string | undefined;
}>;
let failJob: boolean;
let rejectUpload: boolean;
let reads: number;
let pendingReads: number;
let uploadedArchives: number;
let partSizeBytes: number;
let rejectFirstPartAttempt: boolean;
let rejectSecondArchive: boolean;
let rejectStart: boolean;
let rejectProgress: boolean;
/** The 1-based registration the fake API refuses for lack of mailbox storage. */
let refuseStorageAt: number | undefined;
const job = (id: string, status: string) => ({
  id,
  mailboxId,
  status,
  imported: status === "running" ? 0 : uploadedArchives,
  skippedDuplicate: 2,
  skippedSpamTrash: 3,
  failed: failJob ? 1 : 0,
  failures: failJob ? [{ message: "Malformed MIME", offset: 42 }] : [],
  format: "mbox",
  mailboxPath: null,
  filename: "mail.mbox",
  sizeBytes: mime.length,
  offset: mime.length,
  processedBytes: mime.length,
  createdAt: now,
  updatedAt: now,
  startedAt: now,
  completedAt: status === "running" ? null : now,
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "samva-mail-import-cli-"));
  await writeFile(join(directory, "mail.mbox"), mime);
  requests = [];
  failJob = false;
  rejectUpload = false;
  reads = 0;
  pendingReads = 0;
  uploadedArchives = 0;
  partSizeBytes = mime.length;
  rejectFirstPartAttempt = false;
  rejectSecondArchive = false;
  rejectStart = false;
  rejectProgress = false;
  refuseStorageAt = undefined;
  const server = createTestServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const path = req.url ?? "";
    requests.push({
      method: req.method ?? "",
      path,
      body,
      key: req.headers["x-api-key"],
      authorization: req.headers.authorization,
      contentLength: req.headers["content-length"],
    });
    res.setHeader("content-type", "application/json");
    if (path.endsWith("/uploads") && uploadedArchives + 1 === refuseStorageAt) {
      res.statusCode = 402;
      res.end(
        JSON.stringify({
          _tag: "PaymentRequiredError",
          message:
            "This import needs about 1.5 GB of free mailbox storage and your organization has 400 MB left. Free storage by deleting mail, or change your plan in your dashboard's Settings > Billing (/dashboard/<orgSlug>/settings/billing).",
          resource: "mailbox_storage",
          currentUsage: 600,
          limit: 1000,
        }),
      );
    } else if (req.method === "DELETE") {
      res.end(JSON.stringify({ success: true }));
    } else if (path.endsWith("/uploads")) {
      uploadedArchives++;
      res.end(
        JSON.stringify({
          id: "mimport_aaaaaaaaaaaaaaa1",
          archiveId: archiveId(uploadedArchives),
          partSizeBytes,
        }),
      );
    } else if (path.endsWith("/parts")) {
      const { partNumbers } = JSON.parse(body);
      const archive = Number(path.split("/")[7]?.split("-").at(-1));
      res.end(
        JSON.stringify({
          parts: partNumbers.map((partNumber: number) => ({
            partNumber,
            sizeBytes: Math.min(partSizeBytes, mime.length - (partNumber - 1) * partSizeBytes),
            uploadUrl: `${apiUrl}${partPath(archive, partNumber)}`,
          })),
        }),
      );
    } else if (path.startsWith("/archive/")) {
      const failOnce =
        rejectFirstPartAttempt && requests.filter(({ method }) => method === "PUT").length === 1;
      res.statusCode = failOnce
        ? 503
        : rejectUpload || (rejectSecondArchive && path.startsWith("/archive/2/"))
          ? 403
          : 200;
      res.setHeader("etag", `"part-${path.split("/")[3]?.split("?")[0]}"`);
      res.end("{}");
    } else if (path.endsWith("/complete")) {
      res.end(JSON.stringify({ success: true }));
    } else {
      const id = path.split("/")[5] ?? "mimport_aaaaaaaaaaaaaaa1";
      if (
        (path.endsWith("/start") && rejectStart) ||
        (!path.endsWith("/start") && rejectProgress)
      ) {
        res.statusCode = 403;
        res.end(JSON.stringify({ _tag: "ForbiddenError", message: "Synthetic request refusal" }));
      } else if (path.endsWith("/start")) res.end(JSON.stringify(job(id, "running")));
      else {
        reads++;
        res.end(
          JSON.stringify(job(id, reads <= pendingReads ? "running" : failJob ? "failed" : "done")),
        );
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test API address");
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
  runCli(["mailboxes", ...args], {
    configHome: directory,
    cwd: directory,
    env: { SAMVA_API_KEY: "samva_sk_test_mail_import", SAMVA_API_URL: apiUrl },
  });

const apple = async (relative: string) => {
  const path = join(directory, relative);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "mbox"), mime);
  await writeFile(join(path, "table_of_contents"), new Uint8Array([0, 0, 0, 1, 255, 128]));
  await writeFile(
    join(path, "Info.plist"),
    '<?xml version="1.0"?><plist version="1.0"><dict/></plist>',
  );
  return path;
};

describe("mail history import CLI", () => {
  it("discovers one plain mbox without API requests in dry-run", async () => {
    const result = await cli([
      "import",
      mailboxId,
      join(directory, "mail.mbox"),
      "--dry-run",
      "--json",
    ]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout).data).toMatchObject({
      dryRun: true,
      mailboxId,
      files: [{ format: "mbox", sizeBytes: mime.length }],
    });
    expect(requests).toEqual([]);
  });
  it("discovers Apple package contents and preserves nested paths", async () => {
    const root = await apple("Export/Inbox.mbox");
    await apple("Export/Clients.mbox/Invoices.mbox");
    const single = await cli(["import", mailboxId, root, "--dry-run", "--json"]);
    expect(single.code).toBe(0);
    expect(JSON.parse(single.stdout).data.files).toMatchObject([
      { format: "apple", mailboxPath: "Inbox" },
    ]);
    const tree = await cli(["import", mailboxId, join(directory, "Export"), "--dry-run", "--json"]);
    expect(tree.code).toBe(0);
    expect(
      JSON.parse(tree.stdout).data.files.map((file: { mailboxPath: string }) => file.mailboxPath),
    ).toEqual(["Inbox", "Clients/Invoices"]);
    expect(requests).toEqual([]);
  });
  it("skips an empty Apple package and continues the tree in JSON mode", async () => {
    const empty = await apple("Export/A-empty.mbox");
    await writeFile(join(empty, "mbox"), "");
    await apple("Export/Z-populated.mbox");
    const result = await cli(["import", mailboxId, join(directory, "Export"), "--json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout).data).toMatchObject({
      items: [{ status: "done", imported: 1 }],
      skippedEmpty: [{ path: join(empty, "mbox"), mailboxPath: "A-empty", reason: "empty" }],
    });
    expect(requests.filter(({ path }) => path.endsWith("/uploads"))).toHaveLength(1);
    expect(JSON.parse(requests[0]?.body ?? "null")).toMatchObject({
      mailboxPath: "Z-populated",
      sizeBytes: mime.length,
    });
    expect(result.stdout + result.stderr).not.toContain("synthetic-private-token");
  });
  it("reports skipped empty Apple packages for humans without stopping later imports", async () => {
    const empty = await apple("Export/A-empty.mbox");
    await writeFile(join(empty, "mbox"), "");
    await apple("Export/Z-populated.mbox");
    const result = await cli(["import", mailboxId, join(directory, "Export")]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Skipped empty Apple mailbox A-empty");
    expect(result.stdout).toContain("Imported");
    expect(requests.filter(({ method }) => method === "PUT")).toHaveLength(1);
    expect(result.stdout + result.stderr).not.toContain("synthetic-private-token");
  });
  it("treats a tree containing only empty Apple packages as a reported no-op", async () => {
    const empty = await apple("Empty.mbox");
    await writeFile(join(empty, "mbox"), "");
    const result = await runCli(["mailboxes", "import", mailboxId, empty, "--json"], {
      configHome: directory,
      cwd: directory,
      env: { SAMVA_API_URL: apiUrl },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data).toEqual({
      items: [],
      files: [],
      skippedEmpty: [{ path: join(empty, "mbox"), mailboxPath: "Empty", reason: "empty" }],
    });
    expect(requests).toEqual([]);
    const preview = await cli(["import", mailboxId, empty, "--dry-run", "--json"]);
    expect(JSON.parse(preview.stdout).data).toMatchObject({
      files: [],
      skippedEmpty: [{ reason: "empty" }],
    });
  });
  it("recognizes a binary plist sidecar without guessing its flags", async () => {
    const root = await apple("Archive.mbox");
    await writeFile(
      join(root, "table_of_contents"),
      new Uint8Array([98, 112, 108, 105, 115, 116, 48, 48, 0, 0]),
    );
    const result = await cli(["import", mailboxId, root, "--dry-run", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data.files).toMatchObject([
      {
        tableOfContents: "binary-plist",
        warnings: [expect.stringContaining("not provide reliably decoded flags")],
      },
    ]);
  });
  it("continues polling while the job is running and prints human counts", async () => {
    pendingReads = 1;
    const result = await cli(["import", mailboxId, join(directory, "mail.mbox")]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Imported");
    expect(result.stdout).toContain("done");
    expect(reads).toBe(2);
  });
  it("uploads exact MIME bytes before starting, then polls to a pure JSON result", async () => {
    const result = await cli(["import", mailboxId, join(directory, "mail.mbox"), "--json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout).data.items).toMatchObject([
      { status: "done", imported: 1, skippedDuplicate: 2, skippedSpamTrash: 3 },
    ]);
    expect(requests.map(({ method, path }) => [method, path])).toEqual([
      ["POST", `/v1/mailboxes/${mailboxId}/imports/uploads`],
      ["POST", `${archivePath(1)}/parts`],
      ["PUT", partPath(1, 1)],
      ["POST", `${archivePath(1)}/complete`],
      ["POST", `/v1/mailboxes/${mailboxId}/imports/mimport_aaaaaaaaaaaaaaa1/start`],
      ["GET", `/v1/mailboxes/${mailboxId}/imports/mimport_aaaaaaaaaaaaaaa1`],
    ]);
    expect(JSON.parse(requests[0]?.body ?? "null")).toMatchObject({
      filename: "mail.mbox",
      format: "mbox",
      sizeBytes: mime.length,
    });
    expect(requests[2]).toMatchObject({
      body: mime,
      key: undefined,
      authorization: undefined,
      contentLength: String(Buffer.byteLength(mime)),
    });
    expect(reads).toBe(1);
  });
  it("retries a part with a fresh URL and completes with all ETags before starting", async () => {
    partSizeBytes = mime.length - 3;
    rejectFirstPartAttempt = true;
    const result = await cli(["import", mailboxId, join(directory, "mail.mbox"), "--json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(
      requests.filter(({ path }) => path.endsWith("/parts")).map(({ body }) => JSON.parse(body)),
    ).toEqual([{ partNumbers: [1] }, { partNumbers: [1] }, { partNumbers: [2] }]);
    const sent = requests.filter(({ method }) => method === "PUT");
    expect(sent.map(({ body, contentLength }) => [body, contentLength])).toEqual([
      [mime.slice(0, -3), String(partSizeBytes)],
      [mime.slice(0, -3), String(partSizeBytes)],
      [mime.slice(-3), "3"],
    ]);
    const completion = requests.find(({ path }) => path.endsWith("/complete"));
    expect(JSON.parse(completion?.body ?? "null")).toEqual({
      parts: [
        { partNumber: 1, etag: '"part-1"' },
        { partNumber: 2, etag: '"part-2"' },
      ],
    });
    expect(requests.at(-2)?.path).toBe(`${importPath}/start`);
    expect(requests.at(-3)?.path).toBe(`${archivePath(1)}/complete`);
  });
  it("uploads all Apple packages into one job after registering them, then starts and polls once", async () => {
    await apple("Export/Sent Messages.mbox");
    await apple("Export/Clients.mbox/Invoices.mbox");
    const result = await cli(["import", mailboxId, join(directory, "Export"), "--json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout).data.items).toMatchObject([{ status: "done", imported: 2 }]);
    expect(JSON.parse(result.stdout).data.items).toHaveLength(1);
    expect(JSON.parse(result.stdout).data.files[0]).toMatchObject({
      tableOfContents: "unrecognized",
      warnings: [expect.stringContaining("not provide reliably decoded flags")],
    });
    expect(
      requests.filter(({ path }) => path.endsWith("/uploads")).map(({ body }) => JSON.parse(body)),
    ).toMatchObject([
      { format: "apple", mailboxPath: "Sent Messages" },
      { format: "apple", mailboxPath: "Clients/Invoices", importId: "mimport_aaaaaaaaaaaaaaa1" },
    ]);
    expect(requests.filter(({ method }) => method === "PUT")).toHaveLength(2);
    expect(requests.map(({ method, path }) => [method, path])).toEqual([
      ["POST", `/v1/mailboxes/${mailboxId}/imports/uploads`],
      ["POST", `/v1/mailboxes/${mailboxId}/imports/uploads`],
      ["POST", `${archivePath(1)}/parts`],
      ["PUT", partPath(1, 1)],
      ["POST", `${archivePath(1)}/complete`],
      ["POST", `${archivePath(2)}/parts`],
      ["PUT", partPath(2, 1)],
      ["POST", `${archivePath(2)}/complete`],
      ["POST", `/v1/mailboxes/${mailboxId}/imports/mimport_aaaaaaaaaaaaaaa1/start`],
      ["GET", `/v1/mailboxes/${mailboxId}/imports/mimport_aaaaaaaaaaaaaaa1`],
    ]);
    expect(JSON.parse(requests[0]?.body ?? "null")).not.toHaveProperty("importId");
    expect(reads).toBe(1);
  });
  it("stages Inbox, Sent, and Archive before label packages with stable paths in each group", async () => {
    await apple("Export/Z-label.mbox");
    await apple("Export/Archive.mbox");
    await apple("Export/Sent Messages.mbox");
    await apple("Export/Sent.mbox");
    await apple("Export/Inbox.mbox");
    await apple("Export/A-label.mbox");
    await apple("Export/Clients.mbox/Inbox.mbox");
    await apple("Export/Clients.mbox/Sent.mbox");
    await apple("Export/Clients.mbox/Archive.mbox");
    const result = await cli(["import", mailboxId, join(directory, "Export"), "--json"]);
    expect(result.code).toBe(0);
    expect(
      requests
        .filter(({ path }) => path.endsWith("/uploads"))
        .map(({ body }) => JSON.parse(body).mailboxPath),
    ).toEqual([
      "Inbox",
      "Sent",
      "Sent Messages",
      "Archive",
      "A-label",
      "Clients/Archive",
      "Clients/Inbox",
      "Clients/Sent",
      "Z-label",
    ]);
    expect(requests.filter(({ path }) => path.endsWith("/start"))).toHaveLength(1);
    expect(JSON.parse(result.stdout).data.items).toMatchObject([{ imported: 9 }]);
  });
  it("starts no import when a later package upload fails", async () => {
    await apple("Export/Clients.mbox");
    await apple("Export/Projects.mbox");
    rejectSecondArchive = true;
    const result = await cli(["import", mailboxId, join(directory, "Export"), "--json"]);
    expect(result.code).toBe(1);
    expect(requests.filter(({ method }) => method === "PUT")).toHaveLength(4);
    expect(requests.some(({ path }) => path.endsWith("/start"))).toBe(false);
    expect(reads).toBe(0);
  });
  for (const stage of ["start", "progress"] as const) {
    it.each([true, false])(
      `preserves recovery details when ${stage} fails (JSON=%s)`,
      async (json) => {
        rejectStart = stage === "start";
        rejectProgress = stage === "progress";
        const result = await cli([
          "import",
          mailboxId,
          join(directory, "mail.mbox"),
          ...(json ? ["--json"] : []),
        ]);
        expect(result.code).toBe(4);
        const recoveryCommand = `samva mailboxes import-status ${mailboxId} mimport_aaaaaaaaaaaaaaa1`;
        expect(result.stderr).toContain("mimport_aaaaaaaaaaaaaaa1");
        expect(result.stderr).toContain(recoveryCommand);
        expect(result.stdout + result.stderr).not.toContain("synthetic-private-token");
        if (json)
          expect(JSON.parse(result.stderr)).toMatchObject({
            reason: "ForbiddenError",
            status: 403,
            details: { importId: "mimport_aaaaaaaaaaaaaaa1", recoveryCommand },
          });
      },
    );
  }
  it("keeps failed counts and reasons in JSON and exits nonzero", async () => {
    failJob = true;
    const result = await cli(["import", mailboxId, join(directory, "mail.mbox"), "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).data.items).toMatchObject([
      { status: "failed", failed: 1, failures: [{ offset: 42, message: "Malformed MIME" }] },
    ]);
    expect(JSON.parse(result.stderr).reason).toBe("mail_import_failed");
  });
  it("refuses an unsuccessful upload before starting the job", async () => {
    rejectUpload = true;
    const result = await cli(["import", mailboxId, join(directory, "mail.mbox"), "--json"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).details).toMatchObject({
      importId: "mimport_aaaaaaaaaaaaaaa1",
      recoveryCommand: `samva mailboxes import-status ${mailboxId} mimport_aaaaaaaaaaaaaaa1`,
    });
    expect(requests.some(({ path }) => path.endsWith("/start"))).toBe(false);
  });
  it("reports a storage refusal before uploading any bytes", async () => {
    refuseStorageAt = 1;
    const human = await cli(["import", mailboxId, join(directory, "mail.mbox")]);
    expect(human.code).not.toBe(0);
    expect(human.stderr).toContain("free mailbox storage");
    expect(human.stderr).toContain("change your plan");
    expect(human.stderr).not.toContain("import-status");

    requests = [];
    const result = await cli(["import", mailboxId, join(directory, "mail.mbox"), "--json"]);
    expect(JSON.parse(result.stderr)).toMatchObject({
      reason: "PaymentRequiredError",
      status: 402,
      details: { resource: "mailbox_storage", currentUsage: 600, limit: 1000 },
    });
    expect(requests.map(({ method, path }) => [method, path])).toEqual([
      ["POST", `/v1/mailboxes/${mailboxId}/imports/uploads`],
    ]);
  });

  it("discards the registered archives when a later archive is refused for storage", async () => {
    await apple("Export/Inbox.mbox");
    await apple("Export/Projects.mbox");
    refuseStorageAt = 2;
    const result = await cli(["import", mailboxId, join(directory, "Export"), "--json"]);
    expect(JSON.parse(result.stderr)).toMatchObject({
      reason: "PaymentRequiredError",
      status: 402,
    });
    expect(JSON.parse(result.stderr).details).not.toHaveProperty("importId");
    expect(requests.map(({ method, path }) => [method, path])).toEqual([
      ["POST", `/v1/mailboxes/${mailboxId}/imports/uploads`],
      ["POST", `/v1/mailboxes/${mailboxId}/imports/uploads`],
      ["DELETE", importPath],
    ]);
  });

  it("rejects a later oversized archive before creating any uploads", async () => {
    await apple("Export/Inbox.mbox");
    const archive = await apple("Export/Projects.mbox");
    await truncate(join(archive, "mbox"), maxArchiveSizeBytes + 1);

    const result = await cli(["import", mailboxId, join(directory, "Export"), "--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      reason: "mail_import_too_large",
      message: expect.stringContaining("Projects.mbox"),
    });
    expect(requests).toEqual([]);
  });

  it("rejects an oversized combined export before creating any uploads", async () => {
    await apple("Export/Inbox.mbox");
    for (let index = 0; index < maxImportSizeBytes / maxArchiveSizeBytes; index++) {
      const archive = await apple(`Export/Folder-${index}.mbox`);
      await truncate(join(archive, "mbox"), maxArchiveSizeBytes);
    }

    const result = await cli(["import", mailboxId, join(directory, "Export"), "--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      reason: "mail_import_too_large",
      message: expect.stringContaining("Combined archive size"),
    });
    expect(requests).toEqual([]);
  });

  it("rejects missing exports and empty trees without API requests", async () => {
    const result = await cli(["import", mailboxId, join(directory, "missing"), "--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr).reason).toBe("mail_import_path_invalid");
    const empty = await cli(["import", mailboxId, directory, "--dry-run", "--json"]);
    expect(empty.code).toBe(2);
    expect(requests).toEqual([]);
  });
  it("reads status with counts and failure reasons", async () => {
    failJob = true;
    const result = await cli(["import-status", mailboxId, "mimport_aaaaaaaaaaaaaaa1", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({
      status: "failed",
      failures: [{ offset: 42 }],
    });
  });
});
