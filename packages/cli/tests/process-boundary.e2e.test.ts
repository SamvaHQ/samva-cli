import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";

import { type CliOptions, runCli as runCliProcess } from "./support/run-cli";

// Process-level contract tests for the CLI's error/help boundary: a bare or
// parent command renders help to stdout (not a `✗` diagnostic), machine-mode
// parse failures keep stderr to a single JSON line, and human-mode parse
// failures print one message rather than the framework's ERROR block plus a
// hint. These run the real CLI as a subprocess under Bun.

let configHome = "";

const runCli = (args: ReadonlyArray<string>, options: Omit<CliOptions, "configHome"> = {}) =>
  runCliProcess(args, { configHome, ...options });

beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), "samva-cli-boundary-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (configHome) await rm(configHome, { recursive: true, force: true });
});

describe("bare and parent commands render help", () => {
  it("prints root help to stdout with exit 2 and no diagnostic on stderr", async () => {
    const { code, stdout, stderr } = await runCli([]);
    expect(code).toBe(2);
    expect(stdout).toContain("USAGE");
    expect(stdout).toContain("SUBCOMMANDS");
    expect(stdout).not.toContain("✗");
    expect(stderr).toBe("");
  });

  it("prints parent-command help to stdout with exit 2 and clean stderr", async () => {
    const { code, stdout, stderr } = await runCli(["org"]);
    expect(code).toBe(2);
    expect(stdout).toContain("samva org <subcommand>");
    expect(stdout).not.toContain("Help requested");
    expect(stderr).toBe("");
  });

  it("keeps explicit --help at exit 0 with help on stdout", async () => {
    const { code, stdout, stderr } = await runCli(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("SUBCOMMANDS");
    expect(stderr).toBe("");
  });

  it("lists the Git-backed template workflow without lifecycle wrappers", async () => {
    const { code, stdout, stderr } = await runCli(["templates", "--help"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("check");
    expect(stdout).toContain("build");
    expect(stdout).toContain("export");
    expect(stdout).toContain("clone");
    expect(stdout).toContain("publish");
    expect(stdout).not.toMatch(/^\s+credential\s/m);
    expect(stdout).not.toContain("pull");
    expect(stdout).not.toContain("restore");
    expect(stdout).not.toContain("reset");
  });
});

describe("--help in machine mode", () => {
  it("prints one result envelope describing a leaf command", async () => {
    const { code, stdout, stderr } = await runCli(["templates", "types", "--help", "--json"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const envelope = JSON.parse(stdout);
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      type: "result",
      command: "templates.types",
      data: { usage: "samva templates types [flags]", subcommands: [] },
    });
    expect(envelope.data.flags.map((f: { name: string }) => f.name)).toEqual(
      expect.arrayContaining(["out", "by", "check"]),
    );
  });

  it("lists a parent command's subcommands", async () => {
    const { code, stdout, stderr } = await runCli(["brands", "--help", "--json"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const envelope = JSON.parse(stdout);
    expect(envelope).toMatchObject({ type: "result", command: "brands" });
    expect(envelope.data.subcommands.map((c: { name: string }) => c.name)).toEqual(
      expect.arrayContaining(["list", "pull", "push", "default", "remove"]),
    );
  });

  it("describes the root command", async () => {
    const { code, stdout } = await runCli(["--help", "--json"]);
    expect(code).toBe(0);
    const envelope = JSON.parse(stdout);
    expect(envelope).toMatchObject({ type: "result", command: "samva" });
    expect(envelope.data.subcommands.map((c: { name: string }) => c.name)).toContain("brands");
  });

  it("prints one compact line under --jsonl", async () => {
    const { code, stdout, stderr } = await runCli(["brands", "--help", "--jsonl"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout)).toMatchObject({ type: "result", command: "brands" });
  });
});

describe("parse failures keep the output contract", () => {
  it("pipes a large JSON diagnostic completely while preserving exit 2", async () => {
    const flag = `--${"unknown".repeat(15_000)}`;
    const { code, stdout, stderr } = await runCli(["org", "current", flag, "--json"]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({
      schemaVersion: 1,
      type: "error",
      reason: "usage_error",
      message: expect.stringContaining(flag),
    });
  });

  it("machine mode carries only a single JSON diagnostic on stderr", async () => {
    const { code, stdout, stderr } = await runCli(["org", "current", "--nope", "--json"]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    // The framework's plain-text ERROR block would break this parse.
    expect(JSON.parse(stderr)).toMatchObject({
      schemaVersion: 1,
      type: "error",
      reason: "usage_error",
    });
    expect(stderr.trimStart().startsWith("{")).toBe(true);
  });

  it("human mode prints one message, not the framework ERROR block and a hint", async () => {
    const { code, stdout, stderr } = await runCli(["org", "current", "--nope"]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("✗");
    expect(stderr).toContain("--help");
    // Deduped: no framework ERROR banner, and the cause appears exactly once.
    expect(stderr).not.toContain("\nERROR\n");
    expect(stderr.match(/Unrecognized flag/g)).toHaveLength(1);
  });
});

describe("help deduplicates the global --json flag", () => {
  it("lists --json once for a command that also carries the shared jsonFlag", async () => {
    const { code, stdout } = await runCli(["org", "current", "--help"]);
    expect(code).toBe(0);
    const jsonFlagRows = stdout.split("\n").filter((line) => /^\s+--json\b/.test(line));
    expect(jsonFlagRows).toHaveLength(1);
  });
});

describe("subprocess environment isolation", () => {
  it("ignores ambient Samva settings and forced color for machine output", async () => {
    vi.stubEnv("SAMVA_PROFILE", "ambient-profile-must-not-leak");
    vi.stubEnv("SAMVA_ORG", "ambient-org");
    vi.stubEnv("SAMVA_API_KEY", "ambient-key");
    vi.stubEnv("FORCE_COLOR", "1");
    const result = await runCli(["org", "current", "--json"], {
      env: { SAMVA_ORG: "explicit-org" },
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      type: "result",
      data: { activeOrgSlug: "explicit-org" },
    });
  });
});
