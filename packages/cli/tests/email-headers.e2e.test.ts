import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { type CliOptions, runCli as runCliProcess } from "./support/run-cli";

let configHome = "";

const runCli = (args: ReadonlyArray<string>, options: Omit<CliOptions, "configHome"> = {}) =>
  runCliProcess(args, { configHome, ...options });

beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), "samva-cli-email-headers-"));
});

afterEach(async () => {
  if (configHome) await rm(configHome, { recursive: true, force: true });
});

const send = (args: ReadonlyArray<string>) =>
  runCli(["email", "send", "--to", "a@b.com", "--subject", "Hi", "--text", "Hello", ...args], {
    env: { SAMVA_API_KEY: "samva_sk_test_x" },
  });

describe("email send --header", () => {
  it("maps repeatable Name: Value pairs onto email.headers", async () => {
    const result = await send([
      "--header",
      " OTP-Token : 123456 ",
      "--header",
      "X-Trace: req:42",
      "--header",
      "__proto__: trace",
      "--dry-run",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const headers = (
      JSON.parse(result.stdout) as { data: { request: { headers: Record<string, string> } } }
    ).data.request.headers;
    expect(headers).toEqual(
      Object.fromEntries([
        ["OTP-Token", "123456"],
        ["X-Trace", "req:42"],
        ["__proto__", "trace"],
      ]),
    );

    const human = await send(["--header", "OTP-Token: 123456", "--dry-run"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("OTP-Token: 123456");
  });

  it("rejects a pair that has no colon, no name, or no value", async () => {
    for (const raw of ["NoColon", ": 123456", "OTP-Token:", "   ", "OTP-Token:   "]) {
      const result = await send(["--header", raw, "--dry-run", "--json"]);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`--header expects Name: Value, got ${raw}.`);
      expect(JSON.parse(result.stderr)).toMatchObject({
        type: "error",
        reason: "email_header_malformed",
      });
    }
  });

  it("leaves reserved names and the header cap to the API", async () => {
    const many = Array.from(
      { length: 12 },
      (_, index) => ["--header", `X-${index}: v`] as const,
    ).flat();
    const result = await send([
      "--header",
      "From: ada@example.com",
      ...many,
      "--dry-run",
      "--json",
    ]);
    expect(result.code).toBe(0);
    const headers = (
      JSON.parse(result.stdout) as { data: { request: { headers: Record<string, string> } } }
    ).data.request.headers;
    expect(headers.From).toBe("ada@example.com");
    expect(Object.keys(headers)).toHaveLength(13);
  });
});
