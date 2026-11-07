import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest";

import { runCli } from "./support/run-cli";

const id = "mbx_1234567890123456";
const path = `/v1/policies/mailbox/${id}`;
const configuration = {
  presets: [],
  rules: [{ match: { effect: "final" }, atLeast: "person" }],
  instructions: "Review commitments.",
};
const snapshot = { ...configuration, version: 3 };
const replaced = { ...configuration, version: 4 };
const cleared = { presets: [], rules: [], version: 4 };
const conflict = {
  _tag: "ConflictError",
  resource: "Policy",
  id: `mailbox:${id}`,
  message: "This policy changed. Read its current version before replacing it.",
};
interface Recorded {
  method: string;
  path: string;
  body: unknown;
}
let home = "";
let apiUrl = "";
let requests: Recorded[] = [];
let reply: (request: Recorded) => { status: number; body: unknown };
const server = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const recorded = {
    method: request.method!,
    path: request.url!,
    body: raw ? JSON.parse(raw) : undefined,
  };
  requests.push(recorded);
  const result = reply(recorded);
  response.writeHead(result.status, { "content-type": "application/json" });
  response.end(JSON.stringify(result.body));
});
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "samva-cli-policies-"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP port");
  apiUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(home, { recursive: true });
});
beforeEach(() => {
  requests = [];
  reply = (request) => {
    if (request.method === "GET") return { status: 200, body: snapshot };
    return { status: 200, body: request.method === "DELETE" ? cleared : replaced };
  };
});
const cli = (args: ReadonlyArray<string>) =>
  runCli(["policies", ...args], {
    configHome: home,
    env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "samva_sk_test_policies" },
  });
const setData = ["--data", JSON.stringify(configuration)];
const getRequest = { method: "GET", path, body: undefined };
const mutationRequest = (verb: "set" | "clear", ifVersion: number) =>
  verb === "set"
    ? { method: "PUT", path, body: { ...configuration, ifVersion } }
    : { method: "DELETE", path: `${path}?ifVersion=${ifVersion}`, body: undefined };
const mutationArgs = (verb: "set" | "clear") => [
  verb,
  "mailbox",
  id,
  ...(verb === "set" ? setData : []),
];

describe("samva policies", () => {
  it("reads the snapshot version in human and JSON output", async () => {
    const human = await cli(["get", "mailbox", id]);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toMatch(/^Version\s+3$/m);
    expect(human.stdout).toContain("at least person");
    expect(human.stdout).toContain("Review commitments.");
    const machine = await cli(["get", "mailbox", id, "--json"]);
    expect(machine.code, machine.stderr).toBe(0);
    expect(JSON.parse(machine.stdout)).toMatchObject({ type: "result", data: snapshot });
    expect(requests).toEqual([getRequest, getRequest]);
  });

  it("reads the current version for preview and sends no mutation", async () => {
    const preview = await cli([...mutationArgs("set"), "--dry-run", "--json"]);
    expect(preview.code, preview.stderr).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      data: { dryRun: true, request: { ...configuration, ifVersion: 3 } },
    });
    expect(requests).toEqual([getRequest]);
  });

  it("previews an explicitly observed version without a request", async () => {
    const preview = await cli([...mutationArgs("set"), "--if-version", "3", "--dry-run", "--json"]);
    expect(preview.code, preview.stderr).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      data: { request: { ...configuration, ifVersion: 3 } },
    });
    expect(requests).toEqual([]);
  });

  for (const verb of ["set", "clear"] as const) {
    it(`previews an explicit ${verb} version without credentials or an organization`, async () => {
      const configHome = await mkdtemp(join(home, "no-login-"));
      for (const json of [true, false]) {
        const result = await runCli(
          [
            "policies",
            ...mutationArgs(verb),
            "--if-version",
            "0",
            "--dry-run",
            ...(json ? ["--json"] : []),
          ],
          { configHome, env: { SAMVA_API_URL: apiUrl } },
        );
        expect(result.code, result.stderr).toBe(0);
        expect(result.stderr).toBe("");
        if (json)
          expect(JSON.parse(result.stdout).data).toEqual({
            dryRun: true,
            action: `policies.${verb}`,
            kind: "mailbox",
            id,
            ...(verb === "set"
              ? { request: { ...configuration, ifVersion: 0 } }
              : { ifVersion: 0 }),
          });
        else {
          expect(result.stdout).toContain(id);
          expect(result.stdout).toContain("at version 0");
          if (verb === "set") {
            expect(result.stdout).toContain("at least person");
            expect(result.stdout).toContain(configuration.instructions);
          }
        }
      }
      expect(requests).toEqual([]);
    });

    it(`reads then ${verb}s only the version it observed`, async () => {
      const result = await cli([...mutationArgs(verb), "--json"]);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        data: verb === "set" ? replaced : cleared,
      });
      expect(requests).toEqual([getRequest, mutationRequest(verb, 3)]);
    });

    it(`accepts explicit version zero for ${verb} without reading another version`, async () => {
      reply = () => ({
        status: 200,
        body: { ...(verb === "set" ? configuration : { presets: [], rules: [] }), version: 1 },
      });
      const result = await cli([...mutationArgs(verb), "--if-version", "0", "--json"]);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ data: { version: 1 } });
      expect(requests).toEqual([mutationRequest(verb, 0)]);
    });

    it(`preserves a stale ${verb} conflict and does not retry with a newer version`, async () => {
      reply = () => ({ status: 409, body: conflict });
      const result = await cli([...mutationArgs(verb), "--if-version", "2", "--json"]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({
        reason: "ConflictError",
        status: 409,
        details: { resource: "Policy", id: `mailbox:${id}` },
      });
      expect(requests).toEqual([mutationRequest(verb, 2)]);
    });

    it(`stops ${verb} when the policy changes after its automatic read`, async () => {
      reply = (request) =>
        request.method === "GET"
          ? { status: 200, body: snapshot }
          : { status: 409, body: conflict };
      const result = await cli([...mutationArgs(verb), "--json"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("ConflictError");
      expect(requests).toEqual([getRequest, mutationRequest(verb, 3)]);
    });

    it(`rejects invalid ${verb} versions before making a request`, async () => {
      for (const invalid of ["-1", "1.5", "abc"]) {
        const result = await cli([...mutationArgs(verb), "--if-version", invalid, "--json"]);
        expect(result.code).toBe(2);
      }
      expect(requests).toEqual([]);
    });

    it(`documents the ${verb} version option in human and machine help`, async () => {
      const human = await cli([verb, "--help"]);
      expect(human.code, human.stderr).toBe(0);
      expect(human.stdout).toContain("--if-version");
      const machine = await cli([verb, "--help", "--json"]);
      expect(machine.code, machine.stderr).toBe(0);
      expect(JSON.parse(machine.stdout)).toMatchObject({
        type: "result",
        data: { description: expect.any(String) },
      });
      expect(machine.stdout).toContain("if-version");
      expect(requests).toEqual([]);
    });
  }

  it("previews an explicit clear without making a request", async () => {
    const result = await cli(["clear", "mailbox", id, "--if-version", "3", "--dry-run", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { dryRun: true, action: "policies.clear", ifVersion: 3 },
    });
    expect(requests).toEqual([]);
  });

  it("refuses ambiguous rules and unsupported scopes before a request", async () => {
    for (const args of [
      [
        "set",
        "mailbox",
        id,
        "--data",
        '{"presets":[],"rules":[{"match":{},"decide":"run","atLeast":"person"}]}',
      ],
      ["get", "member", "user_1234567890123456"],
    ]) {
      const result = await cli(args);
      expect(result.code).toBe(2);
    }
    expect(requests).toEqual([]);
  });
});
