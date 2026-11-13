#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import * as Capacity from "@samva/platform/dev/capacity";

import { runReleaseCommand } from "./release-command.ts";

await Capacity.withLease(
  { resource: "cpu", slots: "all", label: "CLI release artifacts" },
  async (lease) => {
    const environment = { ...process.env, ...lease.env };

    type PackageManifest = {
      readonly name: string;
      readonly version: string;
    };

    type ReleaseTarget = {
      readonly label: string;
      readonly bunTarget: string;
      readonly platform: NodeJS.Platform;
      readonly arch: string;
      readonly packageRoot: string;
    };

    const CLI_ROOT = resolve(import.meta.dir, "..");
    const REPOSITORY_ROOT = resolve(CLI_ROOT, "../..");
    const SELECTOR_ROOT = join(REPOSITORY_ROOT, "packages", "cli");
    const selectorManifest = JSON.parse(
      await readFile(join(SELECTOR_ROOT, "package.json"), "utf8"),
    ) as PackageManifest;
    const EXECUTABLE = "samva";

    const TARGETS: Record<string, ReleaseTarget> = {
      "darwin-arm64": {
        label: "darwin-arm64",
        bunTarget: "bun-darwin-arm64",
        platform: "darwin",
        arch: "arm64",
        packageRoot: join(REPOSITORY_ROOT, "packages", "cli-darwin-arm64"),
      },
      "darwin-x64": {
        label: "darwin-x64",
        bunTarget: "bun-darwin-x64",
        platform: "darwin",
        arch: "x64",
        packageRoot: join(REPOSITORY_ROOT, "packages", "cli-darwin-x64"),
      },
      "linux-arm64": {
        label: "linux-arm64",
        bunTarget: "bun-linux-arm64",
        platform: "linux",
        arch: "arm64",
        packageRoot: join(REPOSITORY_ROOT, "packages", "cli-linux-arm64"),
      },
      "linux-x64": {
        label: "linux-x64",
        bunTarget: "bun-linux-x64-baseline",
        platform: "linux",
        arch: "x64",
        packageRoot: join(REPOSITORY_ROOT, "packages", "cli-linux-x64"),
      },
    };

    const args = process.argv.slice(2);
    const outRootIndex = args.indexOf("--out-root");
    if (outRootIndex >= 0 && args[outRootIndex + 1] === undefined) {
      throw new Error("--out-root requires a path");
    }
    const RELEASE_ROOT =
      outRootIndex >= 0 ? resolve(args[outRootIndex + 1]!) : join(CLI_ROOT, "dist", "release");
    const NPM_ROOT = join(RELEASE_ROOT, "npm");
    const skipSmoke = args.includes("--no-smoke");
    const prebuilt = args.includes("--prebuilt");
    const requested = args.filter(
      (arg, index) => !arg.startsWith("-") && !(outRootIndex >= 0 && index === outRootIndex + 1),
    );

    const selectedTargets = (): ReleaseTarget[] => {
      const labels = requested.length > 0 ? requested : Object.keys(TARGETS);
      return labels.map((label) => {
        const target = TARGETS[label];
        if (!target) {
          throw new Error(
            `Unknown release target '${label}'. Expected one of: ${Object.keys(TARGETS).join(", ")}`,
          );
        }
        return target;
      });
    };

    const sha256 = async (path: string): Promise<string> => {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      return hash.digest("hex");
    };

    const pack = async (packageRoot: string): Promise<string> => {
      const { stdout: output } = await runReleaseCommand(
        ["bun", "pm", "pack", "--destination", NPM_ROOT, "--quiet"],
        { cwd: packageRoot, env: environment, capture: true },
      );
      const packed = output.trim().split("\n").at(-1);
      if (!packed) throw new Error(`bun pm pack produced no tarball for ${packageRoot}`);
      return isAbsolute(packed) ? packed : join(NPM_ROOT, basename(packed));
    };

    const buildTarget = async (target: ReleaseTarget) => {
      const manifest = JSON.parse(
        await readFile(join(target.packageRoot, "package.json"), "utf8"),
      ) as PackageManifest;
      if (manifest.version !== selectorManifest.version) {
        throw new Error(
          `${manifest.name}@${manifest.version} must match @samva/cli@${selectorManifest.version}`,
        );
      }

      const artifactName = `samva-v${selectorManifest.version}-${target.label}`;
      const stagingDir = join(RELEASE_ROOT, artifactName);
      const executablePath = join(target.packageRoot, EXECUTABLE);
      const archivePath = join(RELEASE_ROOT, `${artifactName}.tar.gz`);

      await rm(stagingDir, { recursive: true, force: true });
      await mkdir(stagingDir, { recursive: true });
      await runReleaseCommand(
        [
          "bun",
          "build",
          "src/bin.ts",
          "--compile",
          "--no-compile-autoload-dotenv",
          "--no-compile-autoload-bunfig",
          `--target=${target.bunTarget}`,
          `--outfile=${executablePath}`,
        ],
        { cwd: CLI_ROOT, env: environment },
      );
      await chmod(executablePath, 0o755);
      await Bun.write(join(stagingDir, EXECUTABLE), Bun.file(executablePath));
      await chmod(join(stagingDir, EXECUTABLE), 0o755);
      await writeFile(
        join(stagingDir, "README.txt"),
        `Samva CLI ${selectorManifest.version} (${target.label})\n\nInstall:\n  install -m 0755 samva /usr/local/bin/samva\n`,
      );
      await rm(archivePath, { force: true });
      await runReleaseCommand(["tar", "-czf", archivePath, "-C", stagingDir, "."], {
        env: environment,
      });

      const packageTarball = await pack(target.packageRoot);
      return {
        target,
        executablePath,
        executableBytes: (await stat(executablePath)).size,
        executableDigest: await sha256(executablePath),
        archive: archivePath,
        archiveDigest: await sha256(archivePath),
        packageTarball,
        packageDigest: await sha256(packageTarball),
      };
    };

    const smokeHostBinary = async (executablePath: string) => {
      const configRoot = await mkdtemp(join(tmpdir(), "samva-smoke-"));
      const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: configRoot };
      delete env["SAMVA_API_KEY"];
      delete env["SAMVA_API_URL"];
      try {
        const { stdout: reported } = await runReleaseCommand([executablePath, "--version"], {
          env,
          capture: true,
        });
        if (!reported.includes(selectorManifest.version)) {
          throw new Error(`smoke: --version returned ${reported.trim()}`);
        }
        await runReleaseCommand([executablePath, "--help"], { env, capture: true });
        const result = await runReleaseCommand([executablePath, "org", "current", "--json"], {
          env,
          capture: true,
          allowFailure: true,
        });
        if (result.stdout.length > 0 || result.exitCode === 0) {
          throw new Error("smoke: unauthenticated org current violated the CLI output contract");
        }
        JSON.parse(result.stderr);
      } finally {
        await rm(configRoot, { recursive: true, force: true });
      }
    };

    // Bun resolves workspace package exports through their built output. Release
    // sessions own this prerequisite here. Managed E2E performs the same builds in
    // its canonical preflight, before starting watched Vite/workerd resources, and
    // passes --prebuilt so packaging cannot mutate dist beneath a live graph.
    if (!prebuilt) {
      await runReleaseCommand(
        ["bun", "run", "turbo", "run", "build", "--filter=samva", `--concurrency=${lease.slots}`],
        { cwd: REPOSITORY_ROOT, env: environment },
      );
      await runReleaseCommand(["bun", "run", "build"], { cwd: CLI_ROOT, env: environment });
    } else {
      const required = [
        join(REPOSITORY_ROOT, "packages", "sdk", "dist", "effect", "index.js"),
        join(CLI_ROOT, "dist", "bin.mjs"),
      ];
      for (const path of required) {
        await access(path).catch(() => {
          throw new Error(`--prebuilt requires the canonical E2E preflight output: ${path}`);
        });
      }
    }

    await rm(RELEASE_ROOT, { recursive: true, force: true });
    await mkdir(NPM_ROOT, { recursive: true });

    const results = [];
    for (const target of selectedTargets()) {
      console.log(`Building ${target.label}…`);
      const result = await buildTarget(target);
      if (target.platform === process.platform && target.arch === process.arch && !skipSmoke) {
        await smokeHostBinary(result.executablePath);
      }
      console.log(`  ${result.packageDigest}  ${relative(RELEASE_ROOT, result.packageTarball)}`);
      results.push(result);
    }

    const selectorTarball = await pack(SELECTOR_ROOT);
    const selectorDigest = await sha256(selectorTarball);
    console.log(`  ${selectorDigest}  ${relative(RELEASE_ROOT, selectorTarball)}`);

    await writeFile(
      join(RELEASE_ROOT, "manifest.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          version: selectorManifest.version,
          selector: {
            package: selectorManifest.name,
            npmTarball: {
              file: relative(RELEASE_ROOT, selectorTarball),
              sha256: selectorDigest,
            },
          },
          artifacts: results.map((result) => ({
            target: result.target.label,
            executable: {
              bytes: result.executableBytes,
              sha256: result.executableDigest,
            },
            githubArchive: {
              file: relative(RELEASE_ROOT, result.archive),
              sha256: result.archiveDigest,
            },
            npmTarball: {
              file: relative(RELEASE_ROOT, result.packageTarball),
              sha256: result.packageDigest,
            },
          })),
        },
        null,
        2,
      )}\n`,
    );
  },
);
