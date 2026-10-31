import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { AUTHORING_MINOR } from "../src/lib/authoring-release";

// Never called: puts the spawned entry in this file's import graph for `vitest --changed`.
void (() => import("../src/bin.ts"));

// Process-level contract for the local authoring commands that run a project's own toolchain:
// the invocation's `--org` reaches a live `samva:brand` lookup, and a snapshot shows the
// project's own assets without an HTTPS origin to serve them from.

const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(CLI_ROOT, "src/bin.ts");
const roots: string[] = [];

const environment = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("SAMVA_")) delete env[key];
  delete env.FORCE_COLOR;
  return { ...env, NO_COLOR: "1" };
};

const run = (root: string, args: readonly string[], env: NodeJS.ProcessEnv = {}) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn("bun", ["run", "--no-env-file", BIN, "templates", ...args], {
      cwd: root,
      env: { ...environment(), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });

// A 1x1 PNG, the smallest valid image the compiler accepts as an asset.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==",
  "base64",
);

const template = (withAsset: boolean) => `import { defineTemplate } from "@samva/markup";
import { Email, Image } from "@samva/markup/email";
import { jsonSchema } from "@samva/markup/input-schema";
${withAsset ? 'import logo from "./logo.png";' : ""}
export default defineTemplate({
  id: "message",
  schema: jsonSchema<{name: string}>({type: "object", properties: {name: {type: "string"}}, required: ["name"], additionalProperties: false}),
  fixtures: { default: {name: "Ada"} },
  email: {
    subject: () => "Hello",
    body: (input) => <Email>${withAsset ? '<Image src={logo} alt="Logo" width={28} height={28} />' : ""}<p className="text-primary">{input.name}</p></Email>,
  },
});
`;

const project = async (options: { readonly asset?: boolean; readonly theme?: string } = {}) => {
  const root = await mkdtemp(join(CLI_ROOT, ".tmp-local-templates-"));
  roots.push(root);
  await mkdir(join(root, "emails"));
  await writeFile(join(root, "emails", "message.tsx"), template(options.asset === true));
  if (options.asset === true) await writeFile(join(root, "emails", "logo.png"), PNG);
  if (options.theme !== undefined) await writeFile(join(root, "theme.css"), options.theme);
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        jsx: "react-jsx",
        jsxImportSource: "@samva/markup/email",
        module: "Preserve",
        moduleResolution: "Bundler",
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        target: "ESNext",
        types: ["@samva/markup/samva-brand"],
      },
      include: ["emails/**/*.tsx"],
    }),
  );
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const brand = {
  id: "brand_7q2xk9mvt4znw8rh",
  slug: "avaan",
  name: "Avaan",
  isDefault: false,
  css: "@theme {\n  --color-primary: #0f766e;\n  --color-primary-foreground: #ffffff;\n}\n",
  assets: {},
  footer: {},
  digest: "avaan-digest",
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z",
};

describe("templates check with --org", () => {
  it("looks the brand up in the organization the invocation names", async () => {
    const root = await project({ theme: '@import "samva:brand/avaan";\n' });
    const bin = await mkdtemp(join(tmpdir(), "samva-org-bin-"));
    roots.push(bin);
    // A `samva` that answers for avaan alone: the lookup has the invocation's flags only as env.
    const envelope = JSON.stringify({
      schemaVersion: 1,
      type: "result",
      command: "brands.get",
      data: brand,
    });
    const script = join(bin, "samva");
    await writeFile(
      script,
      `#!/bin/sh\n[ "$SAMVA_ORG" = "avaan" ] || { echo "no organization selected" >&2; exit 9; }\nprintf '%s\\n' '${envelope}'\n`,
    );
    await chmod(script, 0o755);
    const env = { PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}` };

    const without = await run(root, ["check"], env);
    expect(without.code).toBe(1);
    expect(without.stdout + without.stderr).toContain("brand-unavailable");

    const checked = await run(root, ["check", "--org", "avaan", "--json"], env);
    expect(checked.code, checked.stderr).toBe(0);
    expect(JSON.parse(checked.stdout).data.files[0].template.fixtures[0].email.html).toContain(
      "#0f766e",
    );
  });
});

describe("templates snapshot with imported assets", () => {
  it("loads the project's own assets when no --asset-base is given", async () => {
    const root = await project({ asset: true });
    const tools = await mkdtemp(join(tmpdir(), "samva-chrome-bin-"));
    roots.push(tools);
    const log = join(tools, "log");
    // A browser that records whether the image the page names exists on disk when it is opened.
    const chrome = join(tools, "chrome");
    await writeFile(
      chrome,
      `#!/bin/sh
out=""; url=""; dump=""
for a in "$@"; do
  case "$a" in
    --screenshot=*) out="\${a#--screenshot=}" ;;
    --dump-dom) dump=1 ;;
    file://*) url="\${a#file://}" ;;
  esac
done
if [ -n "$dump" ]; then echo '<html data-samva-height="100"></html>'; exit 0; fi
src=$(sed -n 's/.*<img src="\\([^"]*\\)".*/\\1/p' "$url" | head -1)
if [ -f "$src" ]; then echo present >> "${log}"; else echo "missing:$src" >> "${log}"; fi
printf png > "$out"
`,
    );
    await chmod(chrome, 0o755);
    const out = join(root, "shots");

    const snapped = await run(
      root,
      [
        "snapshot",
        "message",
        "--fixture",
        "default",
        "--viewport",
        "mobile",
        "--scheme",
        "light",
        "--out",
        out,
        "--json",
      ],
      { SAMVA_CHROME: chrome },
    );
    expect(snapped.code, snapped.stderr).toBe(0);
    expect(JSON.parse(snapped.stdout).data).toMatchObject({ ok: true, template: "message" });
    expect((await readFile(log, "utf8")).trim()).toBe("present");
  });

  it("refuses a relative --asset-base and says to omit it", async () => {
    const root = await project({ asset: true });
    const refused = await run(root, [
      "snapshot",
      "message",
      "--fixture",
      "default",
      "--asset-base",
      "./assets",
      "--json",
    ]);
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stderr)).toMatchObject({ reason: "invalid_asset_base" });
  });
});

describe("a project on another authoring release line", () => {
  // An installed `@samva/markup` from an older line, as a project created before an authoring
  // release pins it. Only its manifest is needed: the CLI must refuse before loading any of it.
  const pinOldMarkup = async (root: string) => {
    const markup = join(root, "node_modules", "@samva", "markup");
    await mkdir(markup, { recursive: true });
    await writeFile(
      join(markup, "package.json"),
      JSON.stringify({ name: "@samva/markup", version: "0.15.0", type: "module" }),
    );
  };
  const upgrade = `npm install --save-dev @samva/markup@~${AUTHORING_MINOR}.0 @samva/vite@~${AUTHORING_MINOR}.0`;

  it("stops check and dev with the found version, the CLI's line, and the upgrade command", async () => {
    const root = await project();
    await pinOldMarkup(root);

    for (const args of [["check"], ["check", "--json"], ["dev"]]) {
      const refused = await run(root, args);
      const output = refused.stdout + refused.stderr;
      expect(refused.code, output).toBe(1);
      expect(output).toContain("this project has @samva/markup 0.15.0");
      expect(output).toContain(`this CLI drives ${AUTHORING_MINOR}.x`);
      expect(output).toContain(upgrade);
      expect(output).not.toContain("TypeError");
    }

    await rm(join(root, "node_modules"), { recursive: true, force: true });
    const checked = await run(root, ["check"]);
    expect(checked.code, checked.stderr).toBe(0);
  });

  it("registers an entry by its declared id without building the project", async () => {
    const root = await project();
    await pinOldMarkup(root);
    const added = await run(root, [
      "add",
      "emails/message.tsx",
      "--project-id",
      "tproj_atndyz000z4n7jsh",
      "--dry-run",
      "--json",
    ]);
    expect(added.code, added.stderr).toBe(0);
    expect(JSON.parse(added.stdout).data.request).toMatchObject({
      entryPath: "emails/message.tsx",
      slug: "message",
      name: "Message",
    });
  });
});

describe("templates check with imported assets", () => {
  it("names the origin Samva serves published assets from when --asset-base is missing", async () => {
    const root = await project({ asset: true });
    const checked = await run(root, ["check"]);
    expect(checked.code).toBe(1);
    expect(checked.stderr).toContain("missing-asset-base");
    expect(checked.stderr).toContain("--asset-base https://cdn.samva.dev");
  });
});
