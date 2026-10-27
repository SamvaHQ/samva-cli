import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { runCli as runCliProcess } from "./support/run-cli";

// Process-level contract for `samva org avatar`: the real CLI against a stub API
// that also stands in for the upload host, asserting the three-call flow and
// that a file the API would refuse never leaves the machine.

const MAX_BYTES = 64;
const HOSTED_SRC = "https://cdn.samva.test/identity/img_avatar.webp";

const organization = (avatarUrl: string | null) => ({
  id: "org_1234567890abcdefgh",
  billingAccountId: "ba_1234567890abcdefgh",
  name: "Acme",
  slug: "acme",
  avatarUrl,
  defaultRegion: "US",
  timezone: "America/New_York",
  plan: "free",
  isActive: true,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  metadata: null,
  replyToDefault: null,
  emailFooterEnabledDefault: null,
  messagesUsed: 0,
  messagesUsedThisMonth: 0,
  smsUsed: 0,
  smsUsedThisMonth: 0,
  whatsappUsed: 0,
  whatsappUsedThisMonth: 0,
  emailUsed: 0,
  emailUsedThisMonth: 0,
  contactsUsed: 0,
  conversationsUsed: 0,
  teamMembersUsed: 0,
  messagesResetAt: null,
});

interface Request {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | Array<string> | undefined>>;
  readonly body: Buffer;
}

const startApi = (): Promise<{
  url: string;
  requests: ReadonlyArray<Request>;
  close: () => Promise<void>;
}> =>
  new Promise((resolve) => {
    const requests: Array<Request> = [];
    let origin = "";
    const server = createServer((req, res) => {
      const chunks: Array<Buffer> = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
        const reply = (status: number, value: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(value));
        };
        if (req.method === "POST" && req.url === "/v1/organizations/current/avatar-upload") {
          return reply(200, {
            uploadUrl: `${origin}/api/v1/uploads/organization-avatar`,
            maxBytes: MAX_BYTES,
            contentTypes: ["image/png", "image/jpeg", "image/webp"],
          });
        }
        if (req.method === "PUT" && req.url === "/api/v1/uploads/organization-avatar") {
          return reply(200, { src: HOSTED_SRC });
        }
        if (req.method === "PATCH" && req.url === "/v1/organizations/current") {
          const { avatarUrl } = JSON.parse(body.toString()) as { avatarUrl: string | null };
          return reply(200, organization(avatarUrl));
        }
        return reply(404, { _tag: "ResourceNotFoundError", resource: "route", id: req.url });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      origin = `http://127.0.0.1:${port}`;
      resolve({
        url: origin,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });

let configHome = "";
let workdir = "";
let api: Awaited<ReturnType<typeof startApi>>;

const runCli = (args: ReadonlyArray<string>) =>
  runCliProcess(args, {
    configHome,
    cwd: workdir,
    env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url },
  });

const parseResult = <T>(stdout: string, command: string): T => {
  const envelope = JSON.parse(stdout) as { data: T };
  expect(envelope).toMatchObject({ schemaVersion: 1, type: "result", command });
  return envelope.data;
};

beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), "samva-cli-org-avatar-"));
  workdir = await mkdtemp(join(tmpdir(), "samva-org-avatar-files-"));
  api = await startApi();
});

afterEach(async () => {
  await api.close();
  await rm(configHome, { recursive: true, force: true });
  await rm(workdir, { recursive: true, force: true });
});

describe("samva org avatar set", () => {
  it("uploads the bytes with the key and saves the hosted address", async () => {
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    await writeFile(join(workdir, "logo.PNG"), image);

    const result = await runCli(["org", "avatar", "set", "logo.PNG", "--json"]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(parseResult(result.stdout, "org.avatar.set")).toEqual({
      action: "org.avatar.set",
      slug: "acme",
      avatarUrl: HOSTED_SRC,
    });
    expect(api.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "POST /v1/organizations/current/avatar-upload",
      "PUT /api/v1/uploads/organization-avatar",
      "PATCH /v1/organizations/current",
    ]);
    const [, upload, save] = api.requests;
    expect(upload?.headers["x-api-key"]).toBe("samva_sk_test_x");
    expect(upload?.headers["content-type"]).toBe("image/png");
    expect(upload?.body.equals(image)).toBe(true);
    expect(JSON.parse(save?.body.toString() ?? "")).toEqual({ avatarUrl: HOSTED_SRC });
  });

  it("refuses a file type the avatar does not take before any request", async () => {
    await writeFile(join(workdir, "logo.gif"), Buffer.from("GIF89a"));

    const result = await runCli(["org", "avatar", "set", "logo.gif", "--json"]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ reason: "avatar_unsupported_type" });
    expect(api.requests).toEqual([]);
  });

  it("refuses an image over the upload's limit without sending it", async () => {
    await writeFile(join(workdir, "big.webp"), Buffer.alloc(MAX_BYTES + 1));

    const result = await runCli(["org", "avatar", "set", "big.webp", "--json"]);

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ reason: "avatar_too_large" });
    expect(api.requests.map((request) => request.method)).toEqual(["POST"]);
  });
});

describe("samva org avatar clear", () => {
  it("saves a null avatar", async () => {
    const result = await runCli(["org", "avatar", "clear", "--json"]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(parseResult(result.stdout, "org.avatar.clear")).toEqual({
      action: "org.avatar.clear",
      slug: "acme",
      avatarUrl: null,
    });
    expect(JSON.parse(api.requests[0]?.body.toString() ?? "")).toEqual({ avatarUrl: null });
  });
});
