import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { type AddressInfo, createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import type { MessagesSendData, MessagesSendResponse } from "samva/promises";

import { runCli as runCliProcess } from "./support/run-cli";

type PackageSendRequest = MessagesSendData["body"];
type PackageMessage = MessagesSendResponse;

interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface ResultEnvelope<T> {
  readonly schemaVersion: 1;
  readonly type: "result";
  readonly command: string;
  readonly data: T;
}

const parseResult = <T>(stdout: string, command: string): T => {
  const envelope = JSON.parse(stdout) as ResultEnvelope<T>;
  expect(envelope).toMatchObject({ schemaVersion: 1, type: "result", command });
  return envelope.data;
};

interface PackedManifest {
  readonly name: string;
  readonly version: string;
  readonly bin: Readonly<Record<string, string>>;
  readonly files: ReadonlyArray<string>;
  readonly dependencies?: Readonly<Record<string, string>> | undefined;
  readonly peerDependencies?: Readonly<Record<string, string>> | undefined;
  readonly engines?: Readonly<Record<string, string>> | undefined;
  readonly optionalDependencies?: Readonly<Record<string, string>> | undefined;
  readonly os?: ReadonlyArray<string> | undefined;
  readonly cpu?: ReadonlyArray<string> | undefined;
}

interface PackageApiRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly apiKey: string | undefined;
  readonly clientAttribution: string | undefined;
}

const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY_ROOT = resolve(CLI_ROOT, "../..");
const SELECTOR_ROOT = join(REPOSITORY_ROOT, "packages", "cli");
const SOURCE_MANIFEST = JSON.parse(
  await readFile(join(SELECTOR_ROOT, "package.json"), "utf8"),
) as PackedManifest;
const META_EXPECTED_CONTENTS = [
  "package/package.json",
  "package/LICENSE",
  "package/README.md",
  "package/AGENTS.md",
  "package/bin/samva.cjs",
  "package/dist/bin.mjs",
];
const TARGET = `${process.platform}-${process.arch}`;
const PLATFORM_PACKAGE = `@samva/cli-${TARGET}`;
const PLATFORM_TARBALL_NAME = `samva-cli-${TARGET}-${SOURCE_MANIFEST.version}.tgz`;

let tempRoot = "";
let consumerDir = "";
let configHome = "";
let nativePath = "";
let metaTarball = "";
let platformTarball = "";
let metaContents: ReadonlyArray<string> = [];
let platformContents: ReadonlyArray<string> = [];
let manifest: PackedManifest;
let platformManifest: PackedManifest;
let cli = "";
let api: Awaited<ReturnType<typeof startPackageApi>>;
let unauthenticatedEvidence: ProcessResult;
let fallbackVersionEvidence: ProcessResult;

const run = async (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string | undefined;
    readonly env?: Readonly<Record<string, string>> | undefined;
  } = {},
): Promise<ProcessResult> =>
  new Promise((done, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
  });

const sha256 = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((done) => {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => done(body));
  });

const startPackageApi = async (): Promise<{
  readonly url: string;
  readonly requests: Array<PackageApiRequest>;
  readonly messageRequests: Array<PackageSendRequest>;
  readonly clearRequests: () => void;
  readonly close: () => Promise<void>;
}> => {
  const requests: PackageApiRequest[] = [];
  const messageRequests: PackageSendRequest[] = [];
  let messageSequence = 0;
  const now = "2026-07-21T00:00:00.000Z";
  const server: Server = createServer(async (request, response) => {
    const path = request.url ?? "/";
    const authorization = request.headers.authorization;
    const apiKey = request.headers["x-api-key"] as string | undefined;
    const clientAttribution = request.headers["x-samva-client"] as string | undefined;
    requests.push({
      method: request.method ?? "GET",
      path,
      authorization,
      apiKey,
      clientAttribution,
    });

    if (apiKey !== "samva_sk_test_package") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ _tag: "UnauthorizedError", message: "invalid API key" }));
      return;
    }

    if (request.method === "POST" && path === "/v1/messages") {
      const input = JSON.parse(await readBody(request)) as PackageSendRequest;
      messageRequests.push(input);
      const id = `msg_${String(++messageSequence).padStart(16, "0")}`;
      const message: PackageMessage = {
        id,
        organizationId: "org_0123456789abcdefgh",
        conversationId: null,
        threadId: null,
        parentMessageId: null,
        fromActorId: "api_key_0123456789abcdefgh",
        actorMetadata: null,
        channel: "email",
        direction: "outbound",
        content: { email: { subject: input.email?.subject ?? "", text: input.email?.text ?? "" } },
        metadata: null,
        status: "sent",
        scheduledAt: null,
        tags: [],
        categories: [],
        isTest: false,
        submission: null,
        externalId: null,
        referenceId: null,
        createdAt: now,
        updatedAt: now,
        fromContact: null,
        toContacts: [],
        recipients: [],
        deliveries: [
          {
            id: `del_${String(messageSequence).padStart(16, "0")}`,
            messageId: id,
            recipientId: null,
            channel: "email",
            status: "delivered",
            attemptCount: 1,
            maxAttempts: 1,
            scheduling: null,
            queuedAt: now,
            claimedAt: null,
            lastAttemptAt: now,
            nextRetryAt: null,
            sentAt: now,
            deliveredAt: now,
            readAt: null,
            failedAt: null,
            terminalAt: now,
            errorCode: null,
            errorMessage: null,
            errorDetails: null,
            cost: "0",
            currency: "USD",
            idempotencyKey: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
        emailDeliveryDetails: [],
        smsDeliveryDetails: [],
        whatsappDeliveryDetails: [],
        waitReason: null,
        reviewExpectedAt: null,
        skippedRecipients: [],
      };
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify(message));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ _tag: "NotFoundError", message: "not found" }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    messageRequests,
    clearRequests: () => {
      requests.splice(0, requests.length);
      messageRequests.splice(0, messageRequests.length);
    },
    close: () => new Promise((done) => server.close(() => done())),
  };
};

const runCli = (
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {},
  cwd = consumerDir,
): Promise<ProcessResult> => {
  return runCliProcess(args, {
    executable: cli,
    cwd,
    configHome,
    env: { PATH: nativePath, ...env },
  });
};

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "samva-cli-package-smoke-"));
  consumerDir = join(tempRoot, "consumer");
  configHome = join(tempRoot, "config");
  const nativeTools = join(tempRoot, "native-tools");
  await mkdir(consumerDir, { recursive: true });
  await mkdir(nativeTools, { recursive: true });
  await symlink(process.execPath, join(nativeTools, "node"));
  nativePath = `${nativeTools}:/usr/bin:/bin`;

  expect(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]).toContain(TARGET);
  const built = await run("bun", ["run", "scripts/build-public-packages.ts"], {
    cwd: REPOSITORY_ROOT,
  });
  expect(built.code, built.stderr).toBe(0);
  const npmRoot = join(REPOSITORY_ROOT, "dist", "release", "public-packages", "npm");
  platformTarball = join(npmRoot, PLATFORM_TARBALL_NAME);
  metaTarball = join(npmRoot, `samva-cli-${SOURCE_MANIFEST.version}.tgz`);
  const listed = await run("tar", ["-tzf", metaTarball]);
  expect(listed.code, listed.stderr).toBe(0);
  metaContents = listed.stdout.trim().split("\n").sort();
  const packedManifest = await run("tar", ["-xOf", metaTarball, "package/package.json"]);
  expect(packedManifest.code, packedManifest.stderr).toBe(0);
  manifest = JSON.parse(packedManifest.stdout) as PackedManifest;

  const platformListed = await run("tar", ["-tzf", platformTarball]);
  expect(platformListed.code, platformListed.stderr).toBe(0);
  platformContents = platformListed.stdout.trim().split("\n").sort();
  const packedPlatformManifest = await run("tar", [
    "-xOf",
    platformTarball,
    "package/package.json",
  ]);
  expect(packedPlatformManifest.code, packedPlatformManifest.stderr).toBe(0);
  platformManifest = JSON.parse(packedPlatformManifest.stdout) as PackedManifest;

  const installed = await run(
    "npm",
    ["install", "--offline", "--no-audit", "--no-fund", platformTarball, metaTarball],
    { cwd: consumerDir },
  );
  expect(installed.code, installed.stderr).toBe(0);
  cli = join(consumerDir, "node_modules", ".bin", "samva");

  api = await startPackageApi();
  await mkdir(join(configHome, "samva"), { recursive: true });
  await writeFile(
    join(configHome, "samva", "config.json"),
    `${JSON.stringify({ version: 2, profiles: { default: { credentialIdentity: "none" } } })}\n`,
  );
  unauthenticatedEvidence = await runCli(["templates", "list", "--json"], {
    SAMVA_API_URL: api.url,
    SAMVA_API_KEY: "",
    XDG_CONFIG_HOME: join(tempRoot, "empty-config"),
  });

  const installedPlatform = join(consumerDir, "node_modules", "@samva", `cli-${TARGET}`);
  const disabledPlatform = `${installedPlatform}.disabled`;
  await rename(installedPlatform, disabledPlatform);
  fallbackVersionEvidence = await runCli(["--version"], { PATH: process.env.PATH ?? "" });
  await rename(disabledPlatform, installedPlatform);
});

afterAll(async () => {
  if (api) await api.close();
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

describe("packed CLI clean-install contract", () => {
  it("packs a JavaScript CLI plus exactly one host-native binary artifact", async () => {
    expect(manifest).toMatchObject({
      name: "@samva/cli",
      version: SOURCE_MANIFEST.version,
      bin: { samva: "./bin/samva.cjs" },
      files: ["bin/samva.cjs", "dist/bin.mjs", "README.md", "AGENTS.md", "LICENSE"],
      optionalDependencies: { [PLATFORM_PACKAGE]: SOURCE_MANIFEST.version },
    });
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.engines).toEqual({ node: ">=18" });
    expect(platformManifest).toMatchObject({
      name: PLATFORM_PACKAGE,
      version: SOURCE_MANIFEST.version,
      os: [process.platform],
      cpu: [process.arch],
      files: ["samva", "README.md", "AGENTS.md", "LICENSE"],
    });
    expect(metaContents).toEqual([...META_EXPECTED_CONTENTS].sort());
    expect(platformContents).toEqual(
      [
        "package/package.json",
        "package/README.md",
        "package/AGENTS.md",
        "package/LICENSE",
        "package/samva",
      ].sort(),
    );
  });

  it("installs without workspace linkage and exposes version, help, and auth guidance", async () => {
    const installedPackage = join(consumerDir, "node_modules", "@samva", "cli");
    expect((await lstat(installedPackage)).isSymbolicLink()).toBe(false);
    expect(await realpath(cli)).toMatch(
      new RegExp(`^${(await realpath(consumerDir)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
    expect((await readdir(join(consumerDir, "node_modules", "@samva"))).sort()).toEqual(
      ["cli", `cli-${TARGET}`].sort(),
    );
    const installedBinary = join(consumerDir, "node_modules", "@samva", `cli-${TARGET}`, "samva");
    const expectedMagic = process.platform === "darwin" ? "cffaedfe" : "7f454c46";
    expect((await readFile(installedBinary)).subarray(0, 4).toString("hex")).toBe(expectedMagic);
    expect(await sha256(installedBinary)).toBe(
      await sha256(
        join(
          REPOSITORY_ROOT,
          "dist",
          "release",
          "public-packages",
          `samva-v${manifest.version}-${TARGET}`,
          "samva",
        ),
      ),
    );
    const version = await runCli(["--version"]);
    expect(version).toEqual({ code: 0, stdout: `samva v${manifest.version}\n`, stderr: "" });
    const help = await runCli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("SAMVA_API_KEY");
    expect(help.stdout).toContain("templates");
    const trackingHelp = await runCli(["email", "tracking", "--help"]);
    expect(trackingHelp).toMatchObject({ code: 0, stderr: "" });
    expect(trackingHelp.stdout).toContain("defaults");
    expect(trackingHelp.stdout).toContain("recipient");

    expect(fallbackVersionEvidence).toEqual({
      code: 0,
      stdout: `samva v${manifest.version}\n`,
      stderr: "",
    });

    const unauthenticated = unauthenticatedEvidence;
    expect(unauthenticated.code).not.toBe(0);
    expect(unauthenticated.stdout).toBe("");
    expect(JSON.parse(unauthenticated.stderr)).toMatchObject({
      type: "error",
      reason: "missing_credentials",
    });
  });

  // One smoke send: the installed binary reaches a real API over the wire with
  // the credentials it was given and returns the machine envelope. Command
  // behavior itself is proven against the source CLI in contract.e2e.test.ts —
  // this tier only proves the packaged artifact is wired up at all.
  it("reaches an API and emits the machine envelope through the installed binary", async () => {
    api.clearRequests();
    const sent = await runCli(
      [
        "email",
        "send",
        "--to",
        "recipient@example.com",
        "--subject",
        "Package lifecycle success",
        "--text",
        "compiled package send",
        "--json",
      ],
      { SAMVA_API_URL: api.url, SAMVA_API_KEY: "samva_sk_test_package" },
    );
    expect(sent.code, sent.stderr).toBe(0);
    expect(sent.stderr).toBe("");
    const accepted = parseResult<{
      readonly id: string;
      readonly deliveries: ReadonlyArray<{ readonly status: string }>;
    }>(sent.stdout, "email.send");
    expect(accepted.id).toMatch(/^msg_/);
    expect(api.messageRequests).toEqual([
      expect.objectContaining({
        channel: "email",
        to: [{ email: "recipient@example.com" }],
        email: expect.objectContaining({
          subject: "Package lifecycle success",
          text: "compiled package send",
        }),
      }),
    ]);
    expect(api.requests).toContainEqual(
      expect.objectContaining({
        method: "POST",
        path: "/v1/messages",
        clientAttribution: `cli/${SOURCE_MANIFEST.version}`,
      }),
    );
  });
});
