import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";

import { credentialHelperCommand, runningCliWords } from "../src/commands/templates/project";

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
  it("runs the CLI that configured the repository, then PATH, then the Bun package", () => {
    const command = credentialHelperCommand(
      ["templates", "credential", TEMPLATE_ID],
      ["/opt/samva/bin/samva"],
    );

    const running = command.indexOf("[ -x '/opt/samva/bin/samva' ]");
    const onPath = command.indexOf("command -v samva");
    const fallback = command.indexOf("'bunx' '--bun' '--silent' '@samva/cli'");
    expect(running).toBeGreaterThan(-1);
    expect(running).toBeLessThan(onPath);
    expect(onPath).toBeLessThan(fallback);
    expect(command).toContain("'/opt/samva/bin/samva' 'templates' 'credential'");
    expect(command).not.toContain("--no-install");
    expect(command).toContain("samva_credential() {");
    expect(command).toContain('"$1"');
    expect(command.endsWith("; samva_credential")).toBe(true);
    expect(command).not.toContain("npx");
    expect(command).not.toContain("/tmp/");
  });

  describe("as Git runs it", () => {
    const run = (
      command: string,
      path: string,
    ): Promise<{ code: number; stdout: string; stderr: string }> =>
      new Promise((resolve, reject) => {
        // Git runs a `!` helper through the shell with the credential operation appended.
        const child = spawn("sh", ["-c", `${command.slice(1)} get`], {
          env: { PATH: path, HOME: configHome },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += String(chunk)));
        child.stderr.on("data", (chunk) => (stderr += String(chunk)));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
        child.stdin.end("protocol=https\n");
      });
    const script = async (name: string, body: string) => {
      const path = join(configHome, name);
      await writeFile(path, `#!/bin/sh\n${body}\n`);
      await chmod(path, 0o755);
      return path;
    };

    it("prefers the running CLI over a different samva on PATH", async () => {
      const running = await script("running-cli", 'echo "running $*"');
      const bin = join(configHome, "path-bin");
      await mkdir(bin, { recursive: true });
      await script("path-bin/samva", 'echo "path $*"');

      const result = await run(
        credentialHelperCommand(["templates", "credential", TEMPLATE_ID], [running]),
        `${bin}:/usr/bin:/bin`,
      );

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe(`running templates credential ${TEMPLATE_ID} get\n`);
      expect(result.stderr).toBe("");
    });

    it("falls back to the samva on PATH when the running CLI is gone", async () => {
      const bin = join(configHome, "fallback-bin");
      await mkdir(bin, { recursive: true });
      await script("fallback-bin/samva", 'echo "path $*"');

      const result = await run(
        credentialHelperCommand(
          ["templates", "credential", TEMPLATE_ID],
          [join(configHome, "removed-cli")],
        ),
        `${bin}:/usr/bin:/bin`,
      );

      expect(result.stdout).toBe(`path templates credential ${TEMPLATE_ID} get\n`);
    });

    it("names itself, the binary and the fix when the helper fails", async () => {
      const running = await script("failing-cli", 'echo "Invalid or expired session" >&2; exit 3');

      const result = await run(
        credentialHelperCommand(["templates", "credential", TEMPLATE_ID], [running]),
        "/usr/bin:/bin",
      );

      expect(result.code).toBe(3);
      expect(result.stderr).toContain("Invalid or expired session");
      expect(result.stderr).toContain(
        `samva: the Git credential helper for this repository failed (exit 3) running ${running}.`,
      );
      expect(result.stderr).toContain("Run samva login, or update the CLI, then retry.");
    });
  });

  it("embeds the running executable in the helper a project configures", () => {
    const words = runningCliWords();
    const command = credentialHelperCommand(["templates", "credential", TEMPLATE_ID]);

    expect(words[0]).toBe(process.execPath);
    expect(command).toContain(`[ -x '${process.execPath}' ]`);
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
