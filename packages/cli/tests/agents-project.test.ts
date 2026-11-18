import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";

import { runCli } from "./support/run-cli";

let home: string;
const modules = fileURLToPath(new URL("../node_modules", import.meta.url));
const run = (args: string[]) => runCli(["agents", ...args], { configHome: home });

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "samva-agent-project-"));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

async function scaffold(name: string) {
  const dir = join(home, name);
  const created = await run(["init", dir, "--name", name, "--json"]);
  expect(created.code, created.stderr).toBe(0);
  await symlink(modules, join(dir, "node_modules"), "dir");
  return dir;
}

describe("agent module authoring", () => {
  it("extracts the manifest while retaining native state and Workflow classes in the bundle", async () => {
    const dir = await scaffold("durable-module");
    const entry = join(dir, "agent.ts");
    const source = await readFile(entry, "utf8");
    await writeFile(
      entry,
      `
      import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";
      export class State extends DurableObject {
        async execute() { return this.ctx.storage.kv.get("value"); }
      }
      export class Reminder extends WorkflowEntrypoint {
        async run() { throw new Error("manifest extraction cannot execute Workflow code"); }
      }
      ${source.replace("export default defineAgent({", 'export default defineAgent({ workflows: ["Reminder"],')}
    `,
    );
    const result = await run(["build", dir, "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const built = JSON.parse(result.stdout).data;
    expect(built.manifest.name).toBe("durable-module");
    const bundle = await readFile(built.output, "utf8");
    expect(bundle).toContain("cloudflare:workers");
    expect(bundle).toMatch(/as State\b/u);
    expect(bundle).toMatch(/as Reminder\b/u);
  });
  it("scaffolds explicit imports and builds Markdown, tool declarations, and event handlers", async () => {
    const dir = await scaffold("support");
    expect(await readFile(join(dir, "evals/agent.eval.ts"), "utf8")).toContain("assert");
    const evaluated = await runCli(["--no-env-file", join(dir, "evals/agent.eval.ts")], {
      executable: "bun",
      configHome: home,
    });
    expect(evaluated.code, evaluated.stderr).toBe(0);
    expect(evaluated.stdout).toContain("Agent eval passed");
    const entry = join(dir, "agent.ts");
    const source = await readFile(entry, "utf8");
    await writeFile(
      entry,
      source.replace(
        'ctx.log("Message received");',
        'throw new Error("must not call handler while building");',
      ),
    );
    await writeFile(join(dir, "tools/unregistered.ts"), "export default !!!");
    const built = await run(["build", dir, "--json"]);
    expect(built.code, built.stderr).toBe(0);
    expect(JSON.parse(built.stdout).command).toBe("agents.build");
    const result = JSON.parse(built.stdout).data;
    expect(result.manifest.tools.acknowledge.replay).toBe("safe");
    expect(result.manifest.skills).toEqual(["reschedule"]);
    expect(result.manifest.events).toEqual(["mailbox.message.received"]);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    const bundle = await readFile(result.output, "utf8");
    expect(result.sizeBytes).toBe(Buffer.byteLength(bundle));
    expect(bundle).toContain("Confirm the requested time");
    const info = await run(["info", dir, "--json"]);
    expect(info.code, info.stderr).toBe(0);
    expect(JSON.parse(info.stdout).command).toBe("agents.info");
    expect(JSON.parse(info.stdout).data).toMatchObject({
      manifest: result.manifest,
      diagnostics: [],
      sha256: result.sha256,
    });
    const human = await run(["info", dir]);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain("acknowledge");
    expect(human.stdout).toContain("mailbox.message.received");
    expect(human.stdout).toContain("reschedule");
  });

  it("publishes the bundle to the version endpoint and preserves stale-revision conflicts", async () => {
    const dir = await scaffold("publish-module");
    const requests: Array<{ path: string | undefined; body: unknown }> = [];
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      requests.push({ path: request.url, body: JSON.parse(raw) });
      response.writeHead(409, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          _tag: "ConflictError",
          resource: "agent",
          id: "agt_1234567890123456",
          message: "Read the current revision.",
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing API port");
      const published = await runCli(
        [
          "agents",
          "publish",
          "agt_1234567890123456",
          "--dir",
          dir,
          "--revision",
          "stale",
          "--json",
        ],
        {
          configHome: home,
          env: {
            SAMVA_API_URL: `http://127.0.0.1:${address.port}`,
            SAMVA_API_KEY: "samva_sk_test_agents",
          },
        },
      );
      expect(published.code, published.stderr).toBe(1);
      expect(JSON.parse(published.stderr)).toMatchObject({ reason: "ConflictError", status: 409 });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        path: "/v1/agents/agt_1234567890123456/versions",
        body: {
          revision: "stale",
          bundle: { manifest: { name: "publish-module" }, source: expect.any(String) },
        },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const preview = await run([
      "publish",
      "agt_1234567890123456",
      "--dir",
      dir,
      "--dry-run",
      "--json",
    ]);
    expect(preview.code, preview.stderr).toBe(0);
    expect(JSON.parse(preview.stdout).data.request.bundle.manifest.name).toBe("publish-module");
  });

  it("preserves the entry when output points to it", async () => {
    const dir = await scaffold("no-overwrite");
    const entry = join(dir, "agent.ts");
    const before = await readFile(entry, "utf8");
    const result = await run(["build", dir, "--out", "agent.ts", "--json"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("agent_output_overwrites_entry");
    expect(await readFile(entry, "utf8")).toBe(before);
  });

  it("refuses nonempty scaffolding targets", async () => {
    const dir = await scaffold("existing");
    const result = await run(["init", dir, "--name", "existing", "--json"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("agent_directory_not_empty");
  });

  it.each([
    ["syntax", "export default !!!", "agent_bundle_failed"],
    ["shape", "export default {};", "agent_definition_invalid"],
    ["manifest", "export default { manifest: {} };", "agent_manifest_invalid"],
    [
      "oversize",
      `export default { data: ${JSON.stringify("x".repeat(1024 * 1024 + 1))} };`,
      "agent_bundle_too_large",
    ],
  ])("reports coded %s diagnostics with an honest failure exit", async (name, source, code) => {
    const dir = await scaffold(`invalid-${name}`);
    await writeFile(join(dir, "agent.ts"), source);
    const result = await run(["info", dir, "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).data.diagnostics[0].code).toBe(code);
  });
});
