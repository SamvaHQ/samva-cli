import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";

import { credentialHelperCommand } from "../src/commands/templates/project";

// Never called: puts the spawned entry in this file's import graph for `vitest --changed`.
void (() => import("../src/bin.ts"));

const BIN = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const TEMPLATE_ID = "tmpl_1234567890abcdefgh";
const REMOTE = "https://artifacts.cloudflare.com/samva/template.git";

let configHome = "";

const runCredentialHelper = (apiUrl: string, input: string) =>
  new Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        "bun",
        [
          "run",
          "--no-env-file",
          BIN,
          "--api-url",
          apiUrl,
          "templates",
          "credential",
          TEMPLATE_ID,
          "--scope",
          "write",
          "get",
        ],
        {
          env: {
            ...process.env,
            XDG_CONFIG_HOME: configHome,
            SAMVA_API_KEY: "samva_test_git_helper",
            NO_COLOR: "1",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
      child.stdin.end(input);
    },
  );

beforeAll(async () => {
  configHome = await mkdtemp(join(tmpdir(), "samva-cli-git-"));
});

afterAll(async () => {
  if (configHome) await rm(configHome, { recursive: true, force: true });
});

describe("templates Git credential helper", () => {
  it("uses a PATH-resolved CLI with a Bun package fallback", () => {
    const command = credentialHelperCommand(["templates", "credential", TEMPLATE_ID]);

    expect(command).toContain("command -v samva");
    expect(command).toContain("exec 'samva' 'templates' 'credential'");
    expect(command).toContain("exec 'bunx' '--bun' '--silent' '@samva/cli'");
    expect(command).not.toContain("--no-install");
    expect(command).toContain("samva_credential() {");
    expect(command).toContain('"$1"');
    expect(command.endsWith("; samva_credential")).toBe(true);
    expect(command).not.toContain("npx");
    expect(command).not.toContain("/tmp/");
  });

  it("writes only Git's credential protocol and obtains a fresh repository token", async () => {
    const requests: Array<{
      readonly method: string;
      readonly path: string;
      readonly body: string;
    }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += String(chunk)));
      request.on("end", () => {
        requests.push({
          method: request.method ?? "GET",
          path: request.url ?? "/",
          body,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            request.method === "GET"
              ? { remote: REMOTE, defaultBranch: "main" }
              : {
                  remote: REMOTE,
                  username: "x-access-token",
                  password: "artifact-secret",
                  expiresAt: "2026-09-01T02:00:00.000Z",
                },
          ),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const result = await runCredentialHelper(
        `http://127.0.0.1:${port}`,
        "protocol=https\nhost=artifacts.cloudflare.com\npath=samva/template.git\n\n",
      );

      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(
        "protocol=https\nhost=artifacts.cloudflare.com\npath=samva/template.git\nusername=x-access-token\npassword=artifact-secret\n\n",
      );
      expect(requests).toEqual([
        { method: "GET", path: `/v1/templates/${TEMPLATE_ID}/repository`, body: "" },
        {
          method: "POST",
          path: `/v1/templates/${TEMPLATE_ID}/repository/credentials`,
          body: '{"scope":"write"}',
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("rejects a repository mismatch before requesting a credential", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ remote: REMOTE, defaultBranch: "main" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const result = await runCredentialHelper(
        `http://127.0.0.1:${port}`,
        "protocol=https\nhost=example.com\npath=other.git\n\n",
      );

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("does not match this template project repository");
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
