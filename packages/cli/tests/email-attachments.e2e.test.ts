import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { EMAIL_ATTACHMENT_BUDGET } from "@samva/core/messages/attachment-budget";

import { runCli as runCliProcess } from "./support/run-cli";

// Process-level contracts for `samva email send --attach`: which files travel inline, which go
// through /v1/media, and which requests are never made.

const MIB = 1024 * 1024;
const receipt = {
  id: "msg_1234567890abcdefgh",
  status: "queued",
  waitReason: null,
  reviewExpectedAt: null,
  skippedRecipients: [],
  createdAt: "2026-10-09T00:00:00.000Z",
};

interface Recorded {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}

const startApi = async () => {
  const requests: Array<Recorded> = [];
  let mediaCount = 0;
  let origin = "";
  const server: Server = createServer((req, res) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.method === "PUT" && req.url?.startsWith("/storage/")) {
        res.writeHead(200).end();
      } else if (req.method === "POST" && req.url === "/v1/media") {
        const input = JSON.parse(body.toString()) as {
          filename: string;
          contentType: string;
          sizeBytes: number;
          purpose: string;
        };
        const id = `media_${String(++mediaCount).padStart(16, "0")}`;
        json(201, {
          id,
          organizationId: "org_1234567890abcdefgh",
          status: "pending",
          filename: input.filename,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          width: null,
          height: null,
          durationMs: null,
          purpose: input.purpose,
          checksumSha256: null,
          expiresAt: null,
          createdAt: "2026-10-09T00:00:00.000Z",
          confirmedAt: null,
          upload: {
            url: `${origin}/storage/${id}`,
            method: "PUT",
            headers: { "content-type": input.contentType, "x-amz-meta-signed": "yes" },
            expiresAt: "2026-10-09T01:00:00.000Z",
          },
        });
      } else if (req.method === "POST" && /^\/v1\/media\/[^/]+\/complete$/.test(req.url ?? "")) {
        json(200, {
          media: {
            id: req.url?.split("/")[3],
            organizationId: "org_1234567890abcdefgh",
            status: "ready",
            filename: "x",
            contentType: "application/octet-stream",
            sizeBytes: 1,
            width: null,
            height: null,
            durationMs: null,
            purpose: "attachment",
            checksumSha256: null,
            expiresAt: null,
            createdAt: "2026-10-09T00:00:00.000Z",
            confirmedAt: "2026-10-09T00:00:00.000Z",
          },
          downloadUrl: `${origin}/download`,
        });
      } else if (req.method === "POST" && req.url === "/v1/messages") {
        json(201, receipt);
      } else {
        json(404, { _tag: "ResourceNotFoundError", message: "not found" });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: origin,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

let configHome = "";
let files = "";

beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), "samva-attach-config-"));
  files = await mkdtemp(join(tmpdir(), "samva-attach-files-"));
  await mkdir(files, { recursive: true });
});

afterEach(async () => {
  await rm(configHome, { recursive: true, force: true });
  await rm(files, { recursive: true, force: true });
});

const writeFileOf = async (name: string, bytes: number) => {
  const path = join(files, name);
  await writeFile(path, Buffer.alloc(bytes, 7));
  return path;
};

const send = (api: { url: string }, attachments: ReadonlyArray<string>, extra: string[] = []) =>
  runCliProcess(
    [
      "email",
      "send",
      "--to",
      "a@b.com",
      "--subject",
      "Hi",
      "--text",
      "Hello",
      ...attachments.flatMap((path) => ["--attach", path]),
      ...extra,
    ],
    { configHome, env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url } },
  );

const sendRequest = (requests: ReadonlyArray<Recorded>) => {
  const sends = requests.filter((r) => r.url === "/v1/messages");
  expect(sends).toHaveLength(1);
  const body = JSON.parse(sends[0]!.body.toString()) as {
    email: { attachments: Array<Record<string, unknown>> };
  };
  return body.email;
};

describe("email send --attach", () => {
  it("sends a small file inline with its inferred content type", async () => {
    const api = await startApi();
    try {
      const path = await writeFileOf("notes.pdf", 100);
      const result = await send(api, [path], ["--json"]);
      expect(result.code, result.stderr).toBe(0);
      expect(api.requests.map((r) => r.url)).toEqual(["/v1/messages"]);
      expect(sendRequest(api.requests).attachments).toEqual([
        {
          filename: "notes.pdf",
          contentType: "application/pdf",
          size: 100,
          content: Buffer.alloc(100, 7).toString("base64"),
        },
      ]);
    } finally {
      await api.close();
    }
  });

  it("uploads a file over the inline cap through media and sends its mediaId", async () => {
    const api = await startApi();
    try {
      const path = await writeFileOf("big.bin", EMAIL_ATTACHMENT_BUDGET.maxInlineBytes + 1);
      const result = await send(api, [path]);
      expect(result.code, result.stderr).toBe(0);
      expect(api.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        "POST /v1/media",
        "PUT /storage/media_0000000000000001",
        "POST /v1/media/media_0000000000000001/complete",
        "POST /v1/messages",
      ]);
      const create = JSON.parse(api.requests[0]!.body.toString());
      expect(create).toEqual({
        filename: "big.bin",
        contentType: "application/octet-stream",
        sizeBytes: EMAIL_ATTACHMENT_BUDGET.maxInlineBytes + 1,
        purpose: "attachment",
      });
      const put = api.requests[1]!;
      expect(put.body.length).toBe(EMAIL_ATTACHMENT_BUDGET.maxInlineBytes + 1);
      expect(put.headers["content-type"]).toBe("application/octet-stream");
      expect(put.headers["x-amz-meta-signed"]).toBe("yes");
      expect(put.headers["x-api-key"]).toBeUndefined();
      expect(sendRequest(api.requests).attachments).toEqual([
        {
          filename: "big.bin",
          contentType: "application/octet-stream",
          size: EMAIL_ATTACHMENT_BUDGET.maxInlineBytes + 1,
          mediaId: "media_0000000000000001",
        },
      ]);
    } finally {
      await api.close();
    }
  });

  it("uploads only the largest files needed for the inline remainder to fit", async () => {
    const api = await startApi();
    try {
      const small = await writeFileOf("small.txt", 1 * MIB);
      const large = await writeFileOf("large.zip", 3 * MIB);
      const medium = await writeFileOf("medium.csv", 2 * MIB);
      // 6 MiB total: uploading the 3 MiB file leaves 3 MiB inline, which fits.
      const result = await send(api, [small, large, medium]);
      expect(result.code, result.stderr).toBe(0);
      expect(api.requests.filter((r) => r.url === "/v1/media")).toHaveLength(1);
      const attachments = sendRequest(api.requests).attachments;
      expect(attachments.map((a) => [a["filename"], "mediaId" in a ? "media" : "inline"])).toEqual([
        ["small.txt", "inline"],
        ["large.zip", "media"],
        ["medium.csv", "inline"],
      ]);
    } finally {
      await api.close();
    }
  });

  it("fails on a missing file before any request", async () => {
    const api = await startApi();
    try {
      const missing = join(files, "absent.pdf");
      const result = await send(api, [missing], ["--json"]);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({ reason: "attachment_unreadable" });
      expect(result.stderr).toContain(missing);
      expect(api.requests).toEqual([]);
    } finally {
      await api.close();
    }
  });

  it("fails on too many attachments before any request", async () => {
    const api = await startApi();
    try {
      const paths = await Promise.all(
        Array.from({ length: EMAIL_ATTACHMENT_BUDGET.maxCount + 1 }, (_, i) =>
          writeFileOf(`f${i}.txt`, 10),
        ),
      );
      const result = await send(api, paths, ["--json"]);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stderr)).toMatchObject({ reason: "attachment_budget_count" });
      expect(result.stderr).toContain(String(EMAIL_ATTACHMENT_BUDGET.maxCount));
      expect(api.requests).toEqual([]);
    } finally {
      await api.close();
    }
  });

  it("fails on an over-budget total or file before any request", async () => {
    const api = await startApi();
    try {
      const a = await writeFileOf("a.bin", 13 * MIB);
      const b = await writeFileOf("b.bin", 13 * MIB);
      const total = await send(api, [a, b], ["--json"]);
      expect(total.code).toBe(2);
      expect(JSON.parse(total.stderr)).toMatchObject({
        reason: "attachment_budget_aggregateBytes",
      });
      expect(total.stderr).toContain(String(EMAIL_ATTACHMENT_BUDGET.maxAggregateBytes));

      const huge = await writeFileOf("huge.bin", EMAIL_ATTACHMENT_BUDGET.maxItemBytes + 1);
      const item = await send(api, [huge], ["--json"]);
      expect(item.code).toBe(2);
      expect(JSON.parse(item.stderr)).toMatchObject({ reason: "attachment_too_large" });
      expect(item.stderr).toContain(huge);
      expect(api.requests).toEqual([]);
    } finally {
      await api.close();
    }
  });

  it("keeps --json stdout to the send result and uploads silent on stderr", async () => {
    const api = await startApi();
    try {
      const path = await writeFileOf("big.bin", EMAIL_ATTACHMENT_BUDGET.maxInlineBytes + 1);
      const withAttachment = await send(api, [path], ["--json"]);
      expect(withAttachment.code, withAttachment.stderr).toBe(0);
      expect(withAttachment.stderr).toBe("");
      const plain = await send(api, [], ["--json"]);
      expect(plain.code, plain.stderr).toBe(0);
      expect(withAttachment.stdout).toBe(plain.stdout);
      expect(JSON.parse(plain.stdout)).toMatchObject({ data: { id: receipt.id } });
    } finally {
      await api.close();
    }
  });
});
