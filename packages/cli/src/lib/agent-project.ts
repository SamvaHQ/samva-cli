import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { DEFAULT_AGENT_DEFINITION } from "@samva/core/agents/definition";
import {
  AGENT_BUNDLE_MAX_BYTES,
  AgentModuleManifest,
  AgentModuleTool,
} from "@samva/core/agents/module";
import { Effect, Predicate, Schema } from "effect";
import SamvaPackage from "samva/package.json" with { type: "json" };

import CliPackage from "../../package.json" with { type: "json" };
import { SamvaCliError } from "../errors";

const handler = Schema.Unknown.check(Schema.makeFilter(Predicate.isFunction));
const declarationSchema = Schema.Struct({
  manifest: AgentModuleManifest,
  instructions: Schema.Union([Schema.String, handler]),
  knowledge: Schema.String,
  skills: Schema.Record(Schema.String, Schema.String),
  tools: Schema.Record(
    Schema.String,
    Schema.Struct({ descriptor: AgentModuleTool, execute: handler }),
  ),
  events: Schema.Record(Schema.String, handler),
  schedules: Schema.Record(Schema.String, handler),
});

export interface AgentProjectDiagnostic {
  readonly code: string;
  readonly message: string;
}

const projectError = (code: string, message: string) =>
  new SamvaCliError({ message: `[${code}] ${message}`, details: { code } });

const operation = <A>(code: string, task: () => Promise<A>) =>
  Effect.tryPromise({
    try: task,
    catch: (cause) =>
      projectError(
        code,
        cause instanceof AggregateError
          ? cause.errors.map(String).join("\n")
          : cause instanceof Error
            ? cause.message
            : String(cause),
      ),
  });

export const buildAgent = (dir: string, entry = "agent.ts", out?: string) =>
  Effect.gen(function* () {
    const root = resolve(dir);
    const entryPath = resolve(root, entry);
    const output = out === undefined ? undefined : resolve(root, out);
    if (output === entryPath)
      return yield* projectError(
        "agent_output_overwrites_entry",
        "--out must differ from --entry.",
      );
    const built = yield* operation("agent_bundle_failed", () =>
      Bun.build({
        entrypoints: [entryPath],
        target: "browser",
        format: "esm",
        conditions: ["workerd", "worker", "browser"],
        external: [],
        splitting: false,
        minify: true,
        loader: { ".md": "text" },
      }),
    );
    if (!built.success)
      return yield* projectError("agent_bundle_failed", built.logs.map(String).join("\n"));
    const artifact = built.outputs[0];
    if (built.outputs.length !== 1 || artifact === undefined)
      return yield* projectError(
        "agent_bundle_not_self_contained",
        "Import text rather than external assets: an agent must bundle to one ES module.",
      );
    const bundle = yield* operation("agent_bundle_unreadable", () => artifact.text());
    const sizeBytes = Buffer.byteLength(bundle);
    if (sizeBytes > AGENT_BUNDLE_MAX_BYTES)
      return yield* projectError(
        "agent_bundle_too_large",
        `Bundle is ${sizeBytes} bytes; maximum is ${AGENT_BUNDLE_MAX_BYTES}. Reduce dependencies.`,
      );
    // The descriptor requires evaluating the author's declaration, never its handlers.
    const loaded: unknown = yield* operation(
      "agent_module_load_failed",
      () =>
        import(
          `data:text/javascript;base64,${Buffer.from(`${bundle}\n// ${crypto.randomUUID()}`).toString("base64")}`
        ),
    );
    const definition = Predicate.hasProperty(loaded, "default") ? loaded.default : undefined;
    if (!Predicate.hasProperty(definition, "manifest"))
      return yield* projectError(
        "agent_definition_invalid",
        "The entry must default-export defineAgent({ manifest, instructions, tools, events, skills, schedules }).",
      );
    const manifest = yield* Schema.decodeUnknownEffect(AgentModuleManifest)(
      definition.manifest,
    ).pipe(Effect.mapError((error) => projectError("agent_manifest_invalid", error.message)));
    yield* Schema.decodeUnknownEffect(declarationSchema)(definition).pipe(
      Effect.mapError((error) => projectError("agent_definition_invalid", error.message)),
    );
    if (output !== undefined) {
      yield* operation("agent_output_unwritable", () =>
        mkdir(dirname(output), { recursive: true }),
      );
      yield* operation("agent_output_unwritable", () => writeFile(output, bundle));
    }
    const diagnostics: AgentProjectDiagnostic[] = [];
    return {
      manifest,
      bundle,
      entry: entryPath,
      output,
      sizeBytes,
      sha256: createHash("sha256").update(bundle).digest("hex"),
      diagnostics,
    };
  });

export const initAgent = (dir: string, name: string) =>
  Effect.gen(function* () {
    const root = resolve(dir);
    yield* operation("agent_directory_unwritable", () => mkdir(root, { recursive: true }));
    if ((yield* operation("agent_directory_unreadable", () => readdir(root))).length > 0)
      return yield* projectError(
        "agent_directory_not_empty",
        `Target directory ${root} is not empty. Choose an empty directory.`,
      );
    const {
      instructions: _instructions,
      knowledge: _knowledge,
      ...defaults
    } = DEFAULT_AGENT_DEFINITION;
    const manifest = { ...defaults, name, version: "0.1.0" };
    const files: Record<string, string> = {
      "package.json":
        JSON.stringify(
          {
            name: "samva-agent",
            private: true,
            type: "module",
            scripts: {
              build: "samva agents build",
              info: "samva agents info",
              eval: "bun run evals/agent.eval.ts",
            },
            dependencies: { samva: `^${SamvaPackage.version}`, effect: "^4.1.4" },
            devDependencies: {
              "@samva/cli": `^${CliPackage.version}`,
              "@types/bun": "^1.3.0",
              typescript: "^6.0.0",
            },
          },
          null,
          2,
        ) + "\n",
      "tsconfig.json":
        JSON.stringify(
          {
            compilerOptions: {
              target: "ESNext",
              module: "ESNext",
              moduleResolution: "Bundler",
              strict: true,
              noEmit: true,
              types: ["bun"],
            },
            include: ["**/*.ts"],
          },
          null,
          2,
        ) + "\n",
      "agent.ts": `import { defineAgent } from "samva/agent";\nimport instructions from "./instructions.md";\nimport acknowledge from "./tools/acknowledge";\nimport reschedule from "./skills/reschedule.md";\n\nexport default defineAgent({\n  manifest: ${JSON.stringify(manifest, null, 2).replaceAll("\n", "\n  ")},\n  instructions,\n  skills: { reschedule },\n  tools: { acknowledge },\n  events: {\n    "mailbox.message.received": async (_event, ctx) => { ctx.log("Message received"); },\n  },\n  schedules: {},\n});\n`,
      "instructions.md": `You are ${name}. Help the person clearly and ask before taking consequential actions.\n`,
      "skills/reschedule.md":
        "# Reschedule\n\nConfirm the requested time and availability before changing an appointment.\n",
      "tools/acknowledge.ts": `import { Schema } from "effect";\nimport { defineTool } from "samva/agent";\n\nexport default defineTool({\n  description: "Acknowledge a message without external side effects",\n  input: Schema.Struct({ text: Schema.String }),\n  replay: "safe",\n  execute: async ({ text }) => ({ acknowledged: text }),\n});\n`,
      "evals/agent.eval.ts":
        'import { strict as assert } from "node:assert";\nimport { createClient } from "samva";\nimport type { AgentContext } from "samva/agent";\nimport { defineEval, runAgent, runEval } from "samva/agent/test";\nimport agent from "../agent";\n\nconst logs: unknown[][] = [];\nconst ctx: AgentContext = {\n  capability: {\n    callId: "eval-call", organizationId: "eval-org", agentId: "eval-agent",\n    versionId: "eval-version", bundleSha256: "0".repeat(64), expiresAt: Date.now() + 60_000,\n    trigger: { kind: "event", eventId: "eval-event", eventType: "mailbox.message.received" },\n  },\n  samva: createClient({ apiKey: "eval-only", baseUrl: "http://127.0.0.1:1" }),\n  connections: { call: async () => { throw new Error("Unexpected integration call"); } },\n  memory: { search: async () => [], remember: async () => { throw new Error("Unexpected memory write"); } },\n  log: (...values) => { logs.push([...values]); },\n};\nconst evaluation = defineEval({\n  name: "Acknowledgement and incoming event",\n  run: async (definition) => {\n    const local = runAgent(definition, ctx);\n    assert.deepEqual(await local.tool("acknowledge", { text: "Hello" }), { acknowledged: "Hello" });\n    await local.event({ id: "eval-event", type: "mailbox.message.received", timestamp: "2026-01-01T00:00:00Z", data: {} });\n    assert.deepEqual(logs, [["Message received"]]);\n  },\n});\nawait runEval(agent, evaluation, ctx);\nconsole.log("Agent eval passed");\n',
      ".gitignore": "node_modules/\ndist/\n.env\n",
      "markdown.d.ts": 'declare module "*.md" { const text: string; export default text; }\n',
    };
    for (const [path, content] of Object.entries(files)) {
      const target = resolve(root, path);
      yield* operation("agent_scaffold_failed", () => mkdir(dirname(target), { recursive: true }));
      yield* operation("agent_scaffold_failed", () => writeFile(target, content));
    }
    return { directory: root, manifest, files: Object.keys(files) };
  });
