import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { EXTENSION_BUNDLE_MAX_BYTES, ExtensionManifest } from "@samva/core/mailboxes/extension";
import { Effect, Predicate, Schema } from "effect";
import type { ExtensionDefinition } from "samva/mailbox";
import SamvaPackage from "samva/package.json" with { type: "json" };

import { SamvaCliError } from "../errors";

const moduleDefinitionSchema = Schema.Struct({
  manifest: ExtensionManifest,
  on: Schema.Unknown.check(
    Schema.makeFilter(
      (handlers) =>
        Predicate.isObjectOrArray(handlers) && Object.values(handlers).every(Predicate.isFunction),
    ),
  ),
  fetch: Schema.Unknown.check(Schema.makeFilter(Predicate.isFunction)),
});
const definitionSchema = Schema.declare<ExtensionDefinition>(
  (value): value is ExtensionDefinition => Schema.is(moduleDefinitionSchema)(value),
);

const projectError = (message: string) =>
  new SamvaCliError({ message: `Extension project failed: ${message}` });

export const projectOperation = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => projectError(cause instanceof Error ? cause.message : String(cause)),
  });

export const loadExtension = (entry: string) =>
  Effect.gen(function* () {
    const module = yield* projectOperation(
      () => import(`${pathToFileURL(entry).href}?version=${crypto.randomUUID()}`),
    );
    const value: unknown = module.default;
    return yield* Schema.decodeUnknownEffect(definitionSchema)(value).pipe(
      Effect.mapError(() =>
        projectError(
          "The default export must be a defineExtension result with a valid ExtensionManifest.",
        ),
      ),
    );
  });

export const buildExtension = (dir: string, entry: string, out = "dist/extension.js") =>
  Effect.gen(function* () {
    const root = resolve(dir);
    const output = resolve(root, out);
    if (output === resolve(root, entry))
      return yield* projectError("--out must differ from --entry.");
    const result = yield* Effect.tryPromise({
      try: () =>
        Bun.build({
          entrypoints: [resolve(root, entry)],
          target: "browser",
          format: "esm",
          conditions: ["workerd", "worker", "browser"],
          external: [],
          splitting: false,
          minify: true,
        }),
      catch: (cause) => {
        const detail =
          cause instanceof AggregateError ? cause.errors.map(String).join("\n") : String(cause);
        return projectError(`Could not bundle ${entry}: ${detail}`);
      },
    });
    if (!result.success)
      return yield* projectError(
        `Could not bundle ${entry}: ${result.logs.map(String).join("\n")}`,
      );
    if (result.outputs.length !== 1 || result.outputs[0] === undefined)
      return yield* projectError(
        "The extension must build to one self-contained ES module; remove asset imports.",
      );
    const artifact = result.outputs[0];
    const bundle = yield* projectOperation(() => artifact.text());
    const sizeBytes = Buffer.byteLength(bundle);
    if (sizeBytes > EXTENSION_BUNDLE_MAX_BYTES)
      return yield* projectError(
        `Bundle exceeds EXTENSION_BUNDLE_MAX_BYTES (${EXTENSION_BUNDLE_MAX_BYTES} bytes): ${sizeBytes} bytes. Reduce dependencies.`,
      );
    yield* projectOperation(() => mkdir(dirname(output), { recursive: true }));
    yield* projectOperation(() => writeFile(output, bundle));
    const definition = yield* loadExtension(output);
    const manifest = yield* Schema.decodeEffect(ExtensionManifest)(definition.manifest).pipe(
      Effect.mapError((cause) => projectError(cause.message)),
    );
    return {
      manifest,
      bundle,
      output,
      sizeBytes,
      sha256: createHash("sha256").update(bundle).digest("hex"),
    };
  });

export const initExtension = (dir: string, manifest: ExtensionManifest) =>
  Effect.gen(function* () {
    const root = resolve(dir);
    yield* projectOperation(() => mkdir(root, { recursive: true }));
    if ((yield* projectOperation(() => readdir(root))).length)
      return yield* projectError(
        `Target directory ${root} is not empty. Choose an empty directory.`,
      );
    yield* projectOperation(() => mkdir(resolve(root, "src")));
    const files: Record<string, string> = {
      "package.json":
        JSON.stringify(
          {
            name: manifest.name,
            version: manifest.version,
            private: true,
            type: "module",
            scripts: { dev: "samva extensions dev", publish: "samva extensions publish" },
            dependencies: { samva: `^${SamvaPackage.version}` },
            devDependencies: { "@types/bun": "^1.3.0", typescript: "^6.0.0" },
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
            include: ["src"],
          },
          null,
          2,
        ) + "\n",
      "src/extension.ts": `import { defineExtension } from "samva/mailbox";\n\nexport default defineExtension({\n  manifest: ${JSON.stringify(manifest, null, 2).replaceAll("\n", "\n  ")},\n  on: {\n    "mailbox.message.received": async (event, { samva, log }) => {\n      await samva.mailboxes.reply({\n        id: event.data.mailboxId,\n        messageId: event.data.message.id,\n        text: "Thanks for your message. We received it.",\n      });\n      log("Acknowledged", event.data.message.id);\n    },\n  },\n});\n`,
      ".gitignore": "node_modules/\ndist/\n.env\n",
    };
    if (manifest.runtime === "webhook")
      files["src/server.ts"] =
        `import { createWebhookHandler } from "samva/mailbox/webhook";\nimport extension from "./extension";\n\nconst apiKey = Bun.env.SAMVA_API_KEY;\nconst webhookSecret = Bun.env.SAMVA_WEBHOOK_SECRET;\nif (!apiKey || !webhookSecret) throw new Error("SAMVA_API_KEY and SAMVA_WEBHOOK_SECRET are required");\nBun.serve({ fetch: createWebhookHandler(extension, { apiKey, webhookSecret }) });\n`;
    for (const [path, content] of Object.entries(files))
      yield* projectOperation(() => writeFile(resolve(root, path), content));
    return { directory: root, manifest, files: Object.keys(files) };
  });
