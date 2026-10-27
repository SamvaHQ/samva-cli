import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest";

import { runCli } from "./support/run-cli";

const id = "wep_1234567890abcdef";
const signingSecret = {
  secret: "whsec_test_readable",
  createdAt: "2026-10-18T00:00:00.000Z",
  previousExpiresAt: "2026-10-19T00:00:00.000Z",
};
let requests: Array<{ method: string | undefined; url: string | undefined }> = [];
let status = 200;
let body: unknown = signingSecret;
let server: Server;
let apiUrl = "";
let home = "";

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "samva-webhooks-"));
  server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP port");
  apiUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
});
beforeEach(() => {
  requests = [];
  status = 200;
  body = signingSecret;
});
const cli = (args: ReadonlyArray<string>) =>
  runCli(["webhooks", ...args], {
    configHome: home,
    env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "samva_sk_test_caller" },
  });

describe("webhooks secret", () => {
  it("reads the secret and both timestamps as clean JSON", async () => {
    const result = await cli(["secret", id, "--json", "--log-level", "debug"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      type: "result",
      command: "webhooks.secret",
      data: signingSecret,
    });
    expect(JSON.parse(result.stdout).data).toEqual(signingSecret);
    expect(requests).toEqual([{ method: "GET", url: `/v1/webhooks/${id}/secret` }]);
  });

  it.each([null, signingSecret.previousExpiresAt])(
    "prints human output with previousExpiresAt=%s",
    async (previousExpiresAt) => {
      body = { ...signingSecret, previousExpiresAt };
      const result = await cli(["secret", id]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(signingSecret.secret);
      expect(result.stdout).toContain(signingSecret.createdAt);
      expect(result.stdout).not.toContain("<redacted>");
      if (previousExpiresAt === null) expect(result.stdout).not.toContain("previous secret");
      else
        expect(result.stdout).toContain(
          `The previous secret keeps verifying until ${previousExpiresAt}.`,
        );
    },
  );

  it("preserves null in JSON when no previous secret verifies", async () => {
    body = { ...signingSecret, previousExpiresAt: null };
    const result = await cli(["secret", id, "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data).toEqual(body);
  });

  it.each([
    [403, { _tag: "ForbiddenError", message: "Requires webhooks:update" }, 4],
    [
      404,
      { _tag: "ResourceNotFoundError", message: "Webhook not found", resource: "webhook", id },
      1,
    ],
  ] as const)("maps HTTP %s to a typed CLI error", async (httpStatus, error, exitCode) => {
    status = httpStatus;
    body = error;
    const result = await cli(["secret", id, "--json"]);
    expect(result.code).toBe(exitCode);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      type: "error",
      command: "webhooks.secret",
      reason: error._tag,
      status: httpStatus,
    });
    expect(result.stderr).not.toContain(signingSecret.secret);
  });

  it("documents the command and requires an id before making a request", async () => {
    const help = await cli(["secret", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("samva webhooks secret wep_abc123 --json");
    const missing = await cli(["secret", "--json"]);
    expect(missing.code).toBe(2);
    expect(requests).toEqual([]);
  });
});
