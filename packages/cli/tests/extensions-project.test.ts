import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { ExtensionManifest } from "@samva/core/mailboxes/extension";
import { Schema } from "effect";

import { runCli, spawnCli } from "./support/run-cli";

// Never called: puts the spawned entries in this file's import graph for `vitest --changed`.
void (() => import("./oauth-runner.ts"));
void (() => import("./mailboxes-events-server.ts"));

const runner = fileURLToPath(new URL("./oauth-runner.ts", import.meta.url));
const modules = fileURLToPath(new URL("../node_modules", import.meta.url));
let home: string;
const run = (args: string[]) =>
  runCli(["--no-env-file", runner, "extensions", ...args], { executable: "bun", configHome: home });
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "samva-extension-project-"));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});
async function scaffold(name: string, runtime = "hosted") {
  const dir = join(home, name);
  const result = await run(["init", dir, "--name", name, "--runtime", runtime, "--json"]);
  expect(result.code, result.stderr).toBe(0);
  await symlink(modules, join(dir, "node_modules"), "dir");
  return dir;
}

describe("extension authoring", () => {
  it.each(["hosted", "webhook"])(
    "scaffolds and builds %s with a round-tripping manifest",
    async (runtime) => {
      const dir = await scaffold(`ack-${runtime}`, runtime);
      const source = await readFile(join(dir, "src/extension.ts"), "utf8");
      expect(source).toContain(`  manifest: {\n    "name": "ack-${runtime}",`);
      expect(source).toContain('    "events": [\n      "mailbox.message.received"\n    ],');
      expect(source).toContain('    "permissions": [\n      "read",\n      "send"\n    ]\n  },');
      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      expect(pkg.dependencies["samva"]).toBeTruthy();
      expect(pkg.scripts).toEqual({
        dev: "samva extensions dev",
        publish: "samva extensions publish",
      });
      expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain(".env");
      expect(await readFile(join(dir, "tsconfig.json"), "utf8")).toContain("Bundler");
      if (runtime === "webhook")
        expect(await readFile(join(dir, "src/server.ts"), "utf8")).toContain(
          "createWebhookHandler",
        );
      const build = await run(["build", dir, "--json"]);
      expect(build.code, build.stderr).toBe(0);
      const data = JSON.parse(build.stdout);
      expect(Schema.decodeUnknownSync(ExtensionManifest)(data.manifest)).toEqual(data.manifest);
      expect(data.manifest.runtime).toBe(runtime);
      expect(data.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(data.sizeBytes).toBe(Buffer.byteLength(await readFile(data.output, "utf8")));
      const imported = await runCli(
        [
          "-e",
          `const m=await import(${JSON.stringify(data.output)});console.log(JSON.stringify(m.default.manifest))`,
        ],
        { executable: "bun", configHome: home },
      );
      expect(imported.code, imported.stderr).toBe(0);
      expect(JSON.parse(imported.stdout)).toEqual(data.manifest);
      const human = await run(["build", dir]);
      expect(human.code, human.stderr).toBe(0);
      expect(human.stdout).toContain(`ack-${runtime}@0.1.0`);
      expect(human.stdout).toContain("SHA256");
      expect(human.stdout).toContain(data.manifest.displayName);
      expect(human.stdout).toContain(data.manifest.events[0]);
      expect(human.stdout).toContain("read, send");
      expect(human.stdout).toContain(data.output);
    },
  );
  it("prints human init output and refuses nonempty directories", async () => {
    const dir = join(home, "human-init");
    const first = await run(["init", dir, "--name", "human-init", "--display-name", "Human Init"]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain("Created human-init");
    expect(first.stdout).toContain("Human Init");
    expect(first.stdout).toContain("mailbox.message.received");
    expect(first.stdout).toContain("read, send");
    expect(first.stdout).toContain("package.json, tsconfig.json, src/extension.ts, .gitignore");
    const second = await run(["init", dir, "--name", "human-init"]);
    expect(second.code).not.toBe(0);
    expect(second.stderr).toContain("not empty");
  });
  it.each([
    ["invalid", "export default { manifest: {} };", "defineExtension"],
    ["syntax", "export default !!!", "Could not bundle"],
    [
      "oversize",
      `export default { data: ${JSON.stringify("x".repeat(1024 * 1024 + 1))} };`,
      "EXTENSION_BUNDLE_MAX_BYTES",
    ],
  ])("rejects %s builds", async (name, source, hint) => {
    const dir = join(home, name);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/extension.ts"), source);
    const result = await run(["build", dir, "--json"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(hint);
    expect(result.stdout).toBe("");
  });
  it("refuses --json before connecting, since dev streams", async () => {
    const result = await run(["dev", ".", "--json"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("events_requires_jsonl");
    expect(result.stderr).toContain("--jsonl");
  });
  it.each([true, false])(
    "dispatches and acknowledges with jsonl=%s",
    async (json) => {
      const dir = await scaffold(json ? "dev-ack-json" : "dev-ack-human");
      let reply:
        | { path: string; key: string | undefined; auth: string | undefined; body: unknown }
        | undefined;
      const api = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        reply = {
          path: request.url ?? "",
          key: request.headers["idempotency-key"]?.toString(),
          auth: request.headers["x-api-key"]?.toString(),
          body: JSON.parse(body),
        };
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            status: "sent",
            threadId: "thread_1234567890123456",
            actionId: "mbxact_1234567890123456",
          }),
        );
      });
      await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
      const address = api.address();
      if (!address || typeof address === "string") throw new Error("Missing API address");
      const fixture: ChildProcessWithoutNullStreams = spawn(
        "bun",
        ["--no-env-file", fileURLToPath(new URL("./mailboxes-events-server.ts", import.meta.url))],
        { stdio: "pipe" },
      );
      try {
        const origin = await new Promise<string>((resolve, reject) => {
          fixture.stdout.once("data", (data) => resolve(String(data).trim()));
          fixture.once("error", reject);
        });
        const id = "whevt_1234567890123456";
        const mailboxId = "mbx_1234567890123456";
        await fetch(`${origin}/scenario`, {
          method: "POST",
          body: JSON.stringify({
            frames: [
              {
                kind: "event",
                cursor: "1",
                id,
                event: {
                  type: "mailbox.message.received",
                  timestamp: "2026-10-06T00:00:00Z",
                  data: { mailboxId, namespaceId: null, message: { id: "msg_1234567890123456" } },
                },
              },
            ],
          }),
        });
        const child = spawnCli(
          [
            "--no-env-file",
            runner,
            "extensions",
            "dev",
            dir,
            "--mailbox",
            mailboxId,
            ...(json ? ["--jsonl"] : []),
          ],
          {
            executable: "bun",
            configHome: home,
            env: {
              SAMVA_API_URL: `http://127.0.0.1:${address.port}`,
              SAMVA_EVENTS_URL: origin,
              SAMVA_API_KEY: "sk_installation",
            },
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += String(chunk)));
        child.stderr.on("data", (chunk) => (stderr += String(chunk)));
        const closed = new Promise((resolve) => child.once("close", resolve));
        const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
        // The stream acknowledges once the handler returns; dev then runs until Ctrl+C.
        for (let tries = 0; tries < 200; tries++) {
          const { acks } = await (await fetch(`${origin}/state`)).json();
          if (acks.length > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        child.kill("SIGINT");
        const code = await closed;
        clearTimeout(timeout);
        expect(code, stderr).toBe(0);
        if (json)
          expect(JSON.parse(stdout).data).toMatchObject({
            eventId: id,
            ok: true,
            logs: ["Acknowledged msg_1234567890123456"],
          });
        else {
          expect(stdout).toContain("Acknowledged msg_1234567890123456");
          expect(stdout).toContain(`${id}: succeeded`);
          expect(stdout).toContain("Cursor  1");
        }
        expect(reply).toMatchObject({
          path: `/v1/mailboxes/${mailboxId}/messages/msg_1234567890123456/reply`,
          key: `${id}:reply:1`,
          auth: "sk_installation",
          body: { text: "Thanks for your message. We received it." },
        });
        expect((await (await fetch(`${origin}/state`)).json()).acks).toEqual([
          { kind: "ack", cursor: "1" },
        ]);
      } finally {
        fixture.kill("SIGTERM");
        await new Promise<void>((resolve) => fixture.once("close", () => resolve()));
        await new Promise<void>((resolve) => api.close(() => resolve()));
      }
    },
    20000,
  );
  it("stops on Ctrl+C while a handler is still waiting on the API", async () => {
    const dir = await scaffold("dev-hung-handler");
    // An API that takes the request and never answers: the handler cannot finish.
    let reached: () => void = () => undefined;
    const requested = new Promise<void>((resolve) => (reached = resolve));
    const api = createServer(() => reached());
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const address = api.address();
    if (!address || typeof address === "string") throw new Error("Missing API address");
    const fixture: ChildProcessWithoutNullStreams = spawn(
      "bun",
      ["--no-env-file", fileURLToPath(new URL("./mailboxes-events-server.ts", import.meta.url))],
      { stdio: "pipe" },
    );
    try {
      const origin = await new Promise<string>((resolve, reject) => {
        fixture.stdout.once("data", (data) => resolve(String(data).trim()));
        fixture.once("error", reject);
      });
      const mailboxId = "mbx_1234567890123456";
      await fetch(`${origin}/scenario`, {
        method: "POST",
        body: JSON.stringify({
          frames: [
            {
              kind: "event",
              cursor: "1",
              id: "whevt_1234567890123456",
              event: {
                type: "mailbox.message.received",
                timestamp: "2026-10-06T00:00:00Z",
                data: { mailboxId, namespaceId: null, message: { id: "msg_1234567890123456" } },
              },
            },
          ],
        }),
      });
      const child = spawnCli(
        ["--no-env-file", runner, "extensions", "dev", dir, "--mailbox", mailboxId, "--jsonl"],
        {
          executable: "bun",
          configHome: home,
          env: {
            SAMVA_API_URL: `http://127.0.0.1:${address.port}`,
            SAMVA_EVENTS_URL: origin,
            SAMVA_API_KEY: "sk_installation",
          },
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
      const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
      await requested;
      child.kill("SIGINT");
      const code = await closed;
      clearTimeout(timeout);
      expect(code, stderr).toBe(0);
    } finally {
      fixture.kill("SIGTERM");
      await new Promise<void>((resolve) => fixture.once("close", () => resolve()));
      api.closeAllConnections();
      await new Promise<void>((resolve) => api.close(() => resolve()));
    }
  }, 30000);
});
