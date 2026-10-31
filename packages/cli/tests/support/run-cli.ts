import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { onTestFinished } from "@effect/vitest";

// Never called: puts the spawned entry in this file's import graph for `vitest --changed`.
void (() => import("../../src/bin.ts"));

const BIN = fileURLToPath(new URL("../../src/bin.ts", import.meta.url));
const EXIT_WITH_PARENT = fileURLToPath(new URL("./exit-with-parent.ts", import.meta.url));

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliOptions {
  readonly configHome: string;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly stdin?: string | undefined;
  readonly cwd?: string | undefined;
  /** Installed launcher for package-consumer tests; defaults to the source CLI. */
  readonly executable?: string | undefined;
}

const argv = (args: ReadonlyArray<string>, executable: string | undefined) => {
  if (executable === undefined)
    return ["run", "--preload", EXIT_WITH_PARENT, "--no-env-file", BIN, ...args];
  if (executable === "bun") return ["run", "--preload", EXIT_WITH_PARENT, ...args];
  return [...args];
};

// A failed or timed-out test leaves its child running until the whole run ends; stop it with the
// test instead.
const stopWithTest = (child: ChildProcess) => {
  try {
    onTestFinished(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
  } catch {
    // Spawned from a suite hook, outside any test; that hook owns the child.
  }
};

/** Start the real CLI with only explicitly supplied Samva environment settings. */
export const spawnCli = (args: ReadonlyArray<string>, options: CliOptions) => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("SAMVA_")) delete env[key];
  // A forced-color shell (`FORCE_COLOR=3`) makes the CLI emit ANSI into stderr, and the JSON
  // contract assertions then fail in `JSON.parse`. The harness strips it; the CLI must keep honoring
  // `FORCE_COLOR`, so a test that spawns the CLI without this helper strips it too.
  Object.assign(env, { XDG_CONFIG_HOME: options.configHome }, options.env, {
    NO_COLOR: "1",
    CLI_TEST_RUNNER_PID: String(process.pid),
  });
  delete env["FORCE_COLOR"];
  const child = spawn(options.executable ?? "bun", argv(args, options.executable), {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(options.stdin);
  stopWithTest(child);
  return child;
};

export const runCli = (args: ReadonlyArray<string>, options: CliOptions): Promise<CliResult> =>
  new Promise((resolve, reject) => {
    const child = spawnCli(args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
