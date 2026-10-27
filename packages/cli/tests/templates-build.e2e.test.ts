import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { DIAGNOSTIC_CODES } from "@samva/markup/diagnostics";
import type { BuildTemplatesResult } from "@samva/vite/build";

// Never called: puts the spawned entry in this file's import graph for `vitest --changed`.
void (() => import("../src/bin.ts"));

const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(CLI_ROOT, "src/bin.ts");
const roots: string[] = [];

const environment = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("SAMVA_")) delete env[key];
  delete env.FORCE_COLOR;
  return { ...env, NO_COLOR: "1" };
};

const run = (root: string, args: readonly string[], env: NodeJS.ProcessEnv = {}, bin = BIN) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn("bun", ["--no-env-file", bin, "templates", ...args], {
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

const email = `import { defineTemplate } from "@samva/markup";
import { Email } from "@samva/markup/email";
import { jsonSchema } from "@samva/markup/input-schema";
export default defineTemplate({
  id: "people",
  schema: jsonSchema<{people: Array<{name: string; active: boolean}>}>({
    type: "object", properties: { people: {type: "array", items: {type: "object", properties: {name: {type: "string"}, active: {type: "boolean"}}, required: ["name", "active"], additionalProperties: false}}}, required: ["people"], additionalProperties: false,
  }),
  fixtures: {
    default: {people: [{name: "Ada", active: true}, {name: "Grace", active: false}]},
    other: {people: [{name: "Grace", active: true}]},
  },
  email: {
    subject: (input) => \`People: \${input.people.length}\`,
    preheader: () => "Who is active",
    body: (input) => <Email>{input.people.filter((person) => person.active).map((person) => <p>{person.name}</p>)}</Email>,
  },
});
`;

const multiChannel = `import { defineTemplate } from "@samva/markup";
import { Email } from "@samva/markup/email";
import { jsonSchema } from "@samva/markup/input-schema";
import { Sms } from "@samva/markup/sms";
import { WhatsApp } from "@samva/markup/whatsapp";
export default defineTemplate({
  id: "alert",
  schema: jsonSchema<{code: string}>({type: "object", properties: {code: {type: "string"}}, required: ["code"], additionalProperties: false}),
  fixtures: { default: {code: "123456"} },
  email: { subject: () => "Your code", body: (input) => <Email><p>Code {input.code}</p></Email> },
  sms: (input) => <Sms category="transactional">Your code is {input.code}</Sms>,
  whatsapp: (input) => (
    <WhatsApp language="en_US" category="utility">
      <WhatsApp.Body>Your code is {input.code}</WhatsApp.Body>
    </WhatsApp>
  ),
});
`;

const project = async (source: string, dir = "emails") => {
  const root = await mkdtemp(join(CLI_ROOT, ".tmp-executable-build-"));
  roots.push(root);
  await mkdir(join(root, dir));
  await writeFile(join(root, dir, "message.tsx"), source);
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
      },
      include: [`${dir}/**/*.tsx`],
    }),
  );
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A stub `/v1/brands` answering with one default brand. */
const startBrandApi = (): Promise<{ url: string; close: () => Promise<void> }> =>
  new Promise((resolve) => {
    const brand = {
      id: "brand_7q2xk9mvt4znw8rh",
      slug: "acme",
      name: "Acme",
      isDefault: true,
      css: "@theme {\n  --color-primary: #e11d48;\n  --color-primary-foreground: #ffffff;\n}\n",
      assets: {},
      footer: {},
      digest: "acme-digest",
      createdAt: "2026-09-26T00:00:00.000Z",
      updatedAt: "2026-09-26T00:00:00.000Z",
    };
    const server = createServer((req, res) => {
      res.writeHead(req.url === "/v1/brands" ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/v1/brands" ? { items: [brand] } : {}));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((closed) => server.close(() => closed())),
      });
    });
  });

describe("template authoring commands", () => {
  it.each(["--json", "--jsonl"])(
    "pipes a large check result with %s without truncating its JSON envelope",
    async (mode) => {
      const name = "Ada".repeat(100_000);
      const root = await project(email.replace("Ada", name));
      const checked = await run(root, ["check", mode]);
      expect(checked.code, checked.stderr).toBe(0);
      expect(checked.stderr).toBe("");
      expect(checked.stdout.length).toBeGreaterThan(300_000);
      expect(JSON.parse(checked.stdout)).toMatchObject({
        schemaVersion: 1,
        type: "result",
        command: "templates.check",
        data: { ok: true },
      });
      expect(checked.stdout).toContain(name);
    },
    30_000,
  );

  it("exports pages themed by the project's theme.css and its samva:brand import", async () => {
    const root = await project(
      email.replace(
        "<Email>{input.people",
        '<Email><p className="bg-card text-primary">Welcome</p>{input.people',
      ),
    );
    await writeFile(
      join(root, "theme.css"),
      '@import "samva:brand";\n\n@theme {\n  --color-card: #f5f5f4;\n}\n',
    );
    const api = await startBrandApi();
    try {
      const exported = await run(root, ["export", "--dir", "emails", "--out", "out", "--json"], {
        SAMVA_API_KEY: "samva_sk_test_x",
        SAMVA_API_URL: api.url,
      });
      expect(exported.code, exported.stderr).toBe(0);
      expect(JSON.parse(exported.stdout).data).toMatchObject({
        action: "templates.export",
        ok: true,
      });
      const human = await run(root, ["export", "--dir", "emails", "--out", "out-human"], {
        SAMVA_API_KEY: "samva_sk_test_x",
        SAMVA_API_URL: api.url,
      });
      expect(human.code, human.stderr).toBe(0);
      expect(human.stdout).toContain("Out");
      expect(human.stdout).toContain("people");
      expect(human.stdout.trimStart().startsWith("{")).toBe(false);
      const html = await readFile(join(root, "out/templates/people/default.html"), "utf8");
      expect(html).toContain("#f5f5f4");
      expect(html).toContain("#e11d48");
    } finally {
      await api.close();
    }
  });

  it("checks a brand through the CLI resolver using the project's environment", async () => {
    const root = await project(
      email.replace(
        "<Email>{input.people",
        '<Email><p className="text-primary">Brand</p>{input.people',
      ),
    );
    await writeFile(join(root, "theme.css"), '@import "samva:brand";\n');
    const api = await startBrandApi();
    try {
      await writeFile(
        join(root, ".env"),
        `SAMVA_API_KEY=samva_sk_test_x\nSAMVA_API_URL=${api.url}\n`,
      );
      const checked = await run(root, ["check", "--json"]);
      expect(checked.code, checked.stderr).toBe(0);
      expect(JSON.parse(checked.stdout).data.files[0].template.fixtures[0].email.html).toContain(
        "#e11d48",
      );
      expect(
        JSON.parse(await readFile(join(root, ".samva/brands/acme.json"), "utf8")),
      ).toMatchObject({ digest: "acme-digest" });
    } finally {
      await api.close();
    }
  });

  it("embeds the resolver in the bundled CLI artifact", async () => {
    const root = await project(
      email.replace(
        "<Email>{input.people",
        '<Email><p className="text-primary">Brand</p>{input.people',
      ),
    );
    await writeFile(join(root, "theme.css"), '@import "samva:brand";\n');
    const artifact = join(root, "cli.mjs");
    const bundled = await new Promise<number | null>((done, reject) => {
      const child = spawn("bun", ["build", BIN, "--outfile", artifact, "--target=bun"], {
        stdio: "ignore",
      });
      child.on("error", reject);
      child.on("close", done);
    });
    expect(bundled).toBe(0);
    const api = await startBrandApi();
    try {
      const checked = await run(
        root,
        ["check", "--json"],
        { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url },
        artifact,
      );
      expect(checked.code, checked.stderr).toBe(0);
      expect(JSON.parse(checked.stdout).data.files[0].template.fixtures[0].email.html).toContain(
        "#e11d48",
      );
    } finally {
      await api.close();
    }
  });

  it("resolves the same Samva brand in a check watch session", async () => {
    const root = await project(
      email.replace(
        "<Email>{input.people",
        '<Email><p className="text-primary">Brand</p>{input.people',
      ),
    );
    await writeFile(join(root, "theme.css"), '@import "samva:brand";\n');
    const api = await startBrandApi();
    const child = spawn("bun", ["--no-env-file", BIN, "templates", "check", "--watch", "--jsonl"], {
      cwd: root,
      env: { ...environment(), SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const closed = new Promise<void>((done) => child.on("close", () => done()));
    try {
      const observation = await new Promise<string>((done, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Watch did not check: ${stderr}`)),
          20_000,
        );
        child.on("error", reject);
        child.on("close", () => {
          clearTimeout(timeout);
          reject(new Error(`Watch exited: ${stderr}`));
        });
        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
          if (stdout.includes("\n")) {
            clearTimeout(timeout);
            done(stdout.split("\n")[0]!);
          }
        });
      });
      expect(JSON.parse(observation).data).toMatchObject({ ok: true, action: "templates.check" });
      expect(
        JSON.parse(await readFile(join(root, ".samva/brands/acme.json"), "utf8")),
      ).toMatchObject({ digest: "acme-digest" });
    } finally {
      child.kill("SIGTERM");
      await closed;
      await api.close();
    }
  });

  it("serves a branded editor through templates dev", async () => {
    const root = await project(
      email.replace(
        "<Email>{input.people",
        '<Email><p className="text-primary">Brand</p>{input.people',
      ),
    );
    await writeFile(join(root, "theme.css"), '@import "samva:brand";\n');
    const api = await startBrandApi();
    const child = spawn("bun", ["--no-env-file", BIN, "templates", "dev", "--port", "0"], {
      cwd: root,
      env: { ...environment(), SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const closed = new Promise<void>((done) => child.on("close", () => done()));
    try {
      const url = await new Promise<string>((done, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Editor did not start: ${stderr}`)),
          20_000,
        );
        child.on("error", reject);
        child.on("close", () => {
          clearTimeout(timeout);
          reject(new Error(`Editor exited: ${stderr}`));
        });
        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
          const found = /Samva template editor: (http:\/\/[^\s]+)/.exec(stdout)?.[1];
          if (found !== undefined) {
            clearTimeout(timeout);
            done(found);
          }
        });
      });
      const catalog = await fetch(new URL("api/templates", url)).then((response) =>
        response.json(),
      );
      expect(catalog.diagnostics).not.toContainEqual(
        expect.objectContaining({ severity: "error" }),
      );
      const opened = await fetch(new URL("api/document?id=emails/message.tsx", url)).then(
        (response) => response.json(),
      );
      expect(JSON.stringify(opened)).toContain("#e11d48");
      const capabilities = await fetch(new URL("api/capabilities", url)).then((response) =>
        response.json(),
      );
      expect(capabilities).toMatchObject({
        authenticated: true,
        editorAffordances: {
          authenticatedLabel: "API key set",
          publishingInstructions: { cta: { href: "https://samva.dev/docs/sml/authoring-tsx" } },
        },
      });
    } finally {
      child.kill("SIGTERM");
      await closed;
      await api.close();
    }
  });

  it("checks real inputs and writes every fixture with its schema and compiled template", async () => {
    const root = await project(email);
    await writeFile(
      join(root, "emails/helper.tsx"),
      "export const Signature = () => <p>Helper only</p>;",
    );
    const checked = await run(root, ["check", "--json"]);
    expect(checked.code, checked.stderr).toBe(0);
    const report = JSON.parse(checked.stdout);
    expect(report.data).toMatchObject({ ok: true, buildSchemaVersion: 4 });
    expect(report.data.files).toHaveLength(1);
    const built = await run(root, ["build", "--out", "dist/templates.json", "--json"]);
    expect(built.code, built.stderr).toBe(0);
    expect(JSON.parse(built.stdout).data.ok).toBe(true);
    const artifact = JSON.parse(await readFile(join(root, "dist/templates.json"), "utf8")) as {
      schemaVersion: number;
      result: BuildTemplatesResult;
    };
    expect(artifact.schemaVersion).toBe(4);
    const template = artifact.result.files[0]?.template;
    expect(template?.template).toBe("people");
    expect(template?.channels).toEqual(["email"]);
    expect(template?.source).toBe("emails/message.tsx");
    expect(template?.inputSchema["required"]).toEqual(["people"]);
    expect(template?.fixtures.map((fixture) => fixture.name)).toEqual(["default", "other"]);
    expect(template?.fixtures[0]?.email?.html).toContain("Ada");
    expect(template?.fixtures[0]?.email?.html).not.toContain("Grace");
    expect(template?.fixtures[1]?.email?.subject).toBe("People: 1");
    expect(template?.fixtures[1]?.email?.text).toContain("Grace");
    expect(built.stdout).not.toContain("\u001b");
  });

  it("builds templates/ when no directory is named", async () => {
    const root = await project(email, "templates");
    const checked = await run(root, ["check", "--json"]);
    expect(checked.code, checked.stderr).toBe(0);
    expect(JSON.parse(checked.stdout).data.files[0]).toMatchObject({
      id: "templates/message.tsx",
      ok: true,
    });
  });

  it("reports a defineEmail entry with its upgrade recipe", async () => {
    const root = await project(email.replaceAll("defineTemplate", "defineEmail"));
    const checked = await run(root, ["check", "--json"]);
    expect(checked.code).toBe(1);
    expect(JSON.parse(checked.stdout).data.problems).toContainEqual(
      expect.objectContaining({
        code: "legacy-definition",
        upgrade: DIAGNOSTIC_CODES["legacy-definition"].upgrade,
      }),
    );
    const text = await run(root, ["check"]);
    expect(text.stderr + text.stdout).toContain(
      `Upgrade: ${DIAGNOSTIC_CODES["legacy-definition"].upgrade}`,
    );
  });

  it("reports an invalid non-default fixture and leaves no build artifact", async () => {
    const root = await project(
      email.replace(
        'other: {people: [{name: "Grace", active: true}]}',
        'other: {people: "invalid"}',
      ),
    );
    const result = await run(root, ["build", "--out", "output.json", "--json"]);
    expect(result.code).toBe(1);
    const { data } = JSON.parse(result.stdout);
    expect(data.ok).toBe(false);
    expect(data.problems).toContainEqual(
      expect.objectContaining({
        code: "fixture-invalid",
        provenance: "tsx",
        severity: "error",
        line: expect.any(Number),
        fix: expect.stringContaining("fixture"),
        message: expect.stringContaining('"other"'),
      }),
    );
    await expect(access(join(root, "output.json"))).rejects.toThrow();
  });

  it("requires the actual asset serving base and uses it in the rendered fixture", async () => {
    const root = await project(
      email
        .replace(
          "export default defineTemplate",
          'import logo from "./logo.svg";\nexport default defineTemplate',
        )
        .replace("<Email>{input.people", '<Email><img src={logo} alt="Logo" />{input.people'),
    );
    await writeFile(
      join(root, "emails/logo.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" /></svg>',
    );
    const missing = await run(root, ["build", "--out", "output.json", "--json"]);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout).data.problems).toContainEqual(
      expect.objectContaining({ code: "missing-asset-base" }),
    );
    const built = await run(root, [
      "build",
      "--out",
      "output.json",
      "--asset-base",
      "https://cdn.example.test/email",
      "--json",
    ]);
    expect(built.code, built.stderr).toBe(0);
    const artifact = JSON.parse(await readFile(join(root, "output.json"), "utf8"));
    const template = artifact.result.files[0].template;
    expect(template.fixtures[0].email.html).toMatch(
      /https:\/\/cdn\.example\.test\/email\/[a-f0-9]{64}\.svg/,
    );
  });

  it("builds SMS and WhatsApp bodies beside the email", async () => {
    const root = await project(multiChannel);
    const built = await run(root, ["build", "--out", "output.json", "--json"]);
    expect(built.code, built.stderr).toBe(0);
    const artifact = JSON.parse(await readFile(join(root, "output.json"), "utf8"));
    const template = artifact.result.files[0].template;
    expect(template.channels).toEqual(["email", "sms", "whatsapp"]);
    expect(template.fixtures[0].sms).toBe("Your code is 123456");
    expect(template.fixtures[0].whatsapp.body).toBe("Your code is 123456");
  });

  it("renders one fixture as text, html, json, and per channel", async () => {
    const root = await project(multiChannel);
    const text = await run(root, ["render", "alert", "--fixture", "default"]);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain("Subject: Your code");
    expect(text.stdout).toContain("Code 123456");
    const html = await run(root, ["render", "alert", "--fixture", "default", "--format", "html"]);
    expect(html.stdout).toContain("<html");
    const sms = await run(root, ["render", "alert", "--fixture", "default", "--channel", "sms"]);
    expect(sms.stdout.trim()).toBe("Your code is 123456");
    const json = await run(root, [
      "render",
      "alert",
      "--fixture",
      "default",
      "--json",
      "--out",
      "out/alert.json",
    ]);
    expect(json.code, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout).data).toMatchObject({
      action: "templates.render",
      ok: true,
      template: "alert",
      subject: "Your code",
      diagnostics: [],
    });
    expect(JSON.parse(await readFile(join(root, "out/alert.json"), "utf8"))).toMatchObject({
      ok: true,
    });
  });

  it("renders --format json as a JSON document, with and without --out", async () => {
    const root = await project(multiChannel);
    const printed = await run(root, [
      "render",
      "alert",
      "--fixture",
      "default",
      "--format",
      "json",
    ]);
    expect(printed.code, printed.stderr).toBe(0);
    expect(JSON.parse(printed.stdout)).toMatchObject({
      action: "templates.render",
      ok: true,
      template: "alert",
      subject: "Your code",
    });

    const written = await run(root, [
      "render",
      "alert",
      "--fixture",
      "default",
      "--format",
      "json",
      "--out",
      "out/format.json",
    ]);
    expect(written.code, written.stderr).toBe(0);
    expect(JSON.parse(written.stdout)).toMatchObject({
      ok: true,
      out: join(root, "out/format.json"),
    });
    expect(JSON.parse(await readFile(join(root, "out/format.json"), "utf8"))).toMatchObject({
      ok: true,
      template: "alert",
    });
  });

  it("lists the valid names when the template or fixture is unknown", async () => {
    const root = await project(multiChannel);
    const noTemplate = await run(root, ["render", "missing", "--fixture", "default"]);
    expect(noTemplate.code).toBe(1);
    expect(noTemplate.stderr).toContain("template-not-found");
    expect(noTemplate.stderr).toContain("alert");
    const noFixture = await run(root, ["render", "alert", "--fixture", "nope", "--json"]);
    expect(noFixture.code).toBe(1);
    const { data } = JSON.parse(noFixture.stdout);
    expect(data.ok).toBe(false);
    expect(data.diagnostics[0]).toMatchObject({ code: "unknown-fixture", severity: "error" });
    expect(data.diagnostics[0].message).toContain("default");
  });

  it("keeps init as a credential-free dry-run over the server starter request", async () => {
    const root = await project(email);
    const result = await run(root, [
      "init",
      "--name",
      "New email",
      "--starter",
      "unvalidated-starter",
      "--dir",
      "new-email",
      "--dry-run",
      "--json",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({
      action: "templates.init",
      dryRun: true,
      request: { name: "New email", galleryTemplateId: "unvalidated-starter" },
    });
    await expect(access(join(root, "new-email"))).rejects.toThrow();
  });

  it("keys the generated idempotency key by starter so a changed starter is a new project", async () => {
    const root = await project(email);
    const key = async (starter: string | undefined) => {
      const result = await run(root, [
        "init",
        "--name",
        "New email",
        "--dir",
        "new-email",
        ...(starter === undefined ? [] : ["--starter", starter]),
        "--dry-run",
        "--json",
      ]);
      expect(result.code, result.stderr).toBe(0);
      return JSON.parse(result.stdout).data.request.idempotencyKey as string;
    };

    const [none, a, b, aAgain] = [
      await key(undefined),
      await key("a"),
      await key("b"),
      await key("a"),
    ];
    expect(new Set([none, a, b]).size).toBe(3);
    expect(aAgain).toBe(a);
  });
});
