import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest";
import { operationHints, type PublicOperation } from "@samva/contracts/surface/operations";
import { Arbitrary, Effect, Predicate, Result, Schema, SchemaAST } from "effect";

import { kebab } from "../src/lib/derive/flags";
import { derivedOperations, operationCommandPath } from "../src/lib/derive/tree";
import { createTestServer } from "./support/http-server";
import { runCli } from "./support/run-cli";

interface Request {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly key: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly body: unknown;
}

const requests: Array<Request> = [];
let response: () => { status: number; body: unknown } = () => deny(401);
let apiUrl: string;
let configHome: string;

const contactGroup = {
  id: "cgrp_1234567890123456",
  organizationId: "org_1234567890123456",
  description: null,
  type: "static",
  criteria: null,
  color: null,
  icon: null,
  parentGroupId: null,
  contactCount: 0,
  lastCalculatedAt: null,
  isActive: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const deny = (status: number) => ({
  status,
  body: {
    _tag:
      status === 504
        ? "GatewayTimeoutError"
        : status === 403
          ? "ForbiddenError"
          : "UnauthorizedError",
    message: "Fixture response",
    ...(status === 504 ? { retryAfterSeconds: 1 } : {}),
  },
});

const server = createTestServer(async (request, reply) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const url = new URL(request.url ?? "/", apiUrl);
  requests.push({
    method: request.method ?? "",
    path: url.pathname,
    query: url.searchParams,
    key: request.headers["x-api-key"]?.toString(),
    idempotencyKey: request.headers["idempotency-key"]?.toString(),
    body: body === "" ? undefined : (JSON.parse(body) as unknown),
  });
  const result = response();
  reply.writeHead(result.status, { "content-type": "application/json" });
  reply.end(JSON.stringify(result.body));
});

beforeAll(async () => {
  configHome = await mkdtemp(join(tmpdir(), "samva-derived-cli-"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing fixture port");
  apiUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(configHome, { recursive: true, force: true });
});

beforeEach(() => {
  requests.length = 0;
  response = () => deny(401);
});

const invoke = (args: ReadonlyArray<string>, stdin?: string) =>
  runCli(args, {
    configHome,
    stdin,
    env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "samva_sk_derived_fixture" },
  });

const example = (schema: Schema.Top): unknown => {
  const codec = Schema.make<Schema.Codec<unknown>>(schema.ast);
  const samples = Effect.runSync(
    Arbitrary.sampleEffect(Arbitrary.schema(codec), { numRuns: 5, seed: 42 }),
  );
  const encode = Schema.encodeUnknownResult(codec, { onExcessProperty: "error" });
  for (const sample of samples) {
    const result = encode(sample);
    if (Result.isSuccess(result)) return result.success;
  }
  throw new Error("No wire example satisfies the contract");
};

const payloadExample = (operation: PublicOperation): unknown => {
  if (operation.operationId === "analytics.exportData") {
    return { after: "2026-01-01T00:00:00.000Z", before: "2026-01-02T00:00:00.000Z" };
  }
  if (operation.operationId === "messages.validateEmail") {
    return {
      channel: "email",
      to: [{ email: "reader@example.com" }],
      from: { email: "sender@example.com" },
      email: { subject: "Hello", text: "Hello" },
    };
  }
  const codec = operation.payload.get("application/json")?.schemas[0];
  return codec === undefined ? undefined : example(codec);
};

const requestExample = (operation: PublicOperation) => {
  const params =
    operation.params === undefined
      ? undefined
      : operation.path.endsWith("/:splitId")
        ? { splitId: "split_fixture" }
        : example(operation.params);
  const pathArgs: Array<string> = [];
  const path = operation.path.replace(/:[A-Za-z0-9_]+/g, (segment) => {
    const key = segment.slice(1);
    if (!Predicate.isObject(params) || typeof params[key] !== "string") {
      throw new Error(`No positional example for ${operation.operationId}: ${key}`);
    }
    pathArgs.push(params[key]);
    return encodeURIComponent(params[key]);
  });
  const query: Array<readonly [string, string]> = [];
  const querySchema = operation.query;
  if (querySchema !== undefined && SchemaAST.isObjects(querySchema.ast)) {
    const required = querySchema.ast.propertySignatures.filter(
      ({ type }) => !SchemaAST.isOptional(type),
    );
    if (required.length > 0) {
      const wire = example(querySchema);
      for (const { name } of required) {
        if (
          typeof name !== "string" ||
          !Predicate.isObject(wire) ||
          typeof wire[name] !== "string"
        ) {
          throw new Error(`No query example for ${operation.operationId}: ${String(name)}`);
        }
        query.push([name, wire[name]]);
      }
    }
  }
  const data = JSON.stringify(payloadExample(operation));
  const { destructive } = operationHints(operation);
  const args = [
    ...operationCommandPath(operation),
    ...pathArgs,
    ...query.flatMap(([field, value]) => [`--${kebab(field)}`, value]),
    ...(operation.idempotent ? ["--idempotency-key", "test-request-key"] : []),
    ...(data === undefined ? [] : ["--data", data]),
    ...(destructive ? ["--yes"] : []),
    "--json",
  ];
  return {
    args,
    path,
    query,
    payload: data === undefined ? undefined : (JSON.parse(data) as unknown),
  };
};

describe("derived CLI request contracts", () => {
  it.each(derivedOperations.map((operation) => [operation.operationId, operation] as const))(
    "%s routes and encodes its declared input",
    async (_id, operation) => {
      const { args, path, query, payload } = requestExample(operation);
      if (operationHints(operation).readOnly === false) {
        const preview = await invoke([...args, "--dry-run"]);
        expect(preview.code, preview.stderr).toBe(0);
        expect(JSON.parse(preview.stdout)).toMatchObject({
          type: "result",
          command: operationCommandPath(operation).join("."),
          data: { dryRun: true, method: operation.method, path: operation.path },
        });
        expect(requests).toHaveLength(0);
      }
      const result = await invoke(args);
      expect(result.code, result.stderr).toBe(4);
      expect(JSON.parse(result.stderr)).toMatchObject({ reason: "UnauthorizedError", status: 401 });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        method: operation.method,
        path,
        key: "samva_sk_derived_fixture",
        idempotencyKey: operation.idempotent ? "test-request-key" : undefined,
        body: payload,
        query: new URLSearchParams(query.map(([field, value]) => [field, value])),
      });
    },
  );

  it("encodes repeatable choices and streams each page as JSONL", async () => {
    const cursor = Buffer.from(
      JSON.stringify({
        at: "2026-01-01T00:00:00.000000Z",
        id: "anchor",
      }),
    ).toString("base64url");
    response = () => ({
      status: 200,
      body: {
        items: [{ ...contactGroup, name: `Group ${requests.length}` }],
        nextCursor: requests.length === 1 ? cursor : null,
      },
    });
    const result = await invoke([
      "contact-groups",
      "list",
      "--type",
      "static",
      "--type",
      "smart",
      "--no-is-active",
      "--all",
      "--jsonl",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(
      result.stdout
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toMatchObject([
      { type: "result", command: "contact-groups.list", data: { name: "Group 1" } },
      { type: "result", command: "contact-groups.list", data: { name: "Group 2" } },
    ]);
    expect(requests.map(({ query }) => query.getAll("type"))).toEqual([
      ["static", "smart"],
      ["static", "smart"],
    ]);
    expect(requests.map(({ query }) => query.get("isActive"))).toEqual(["false", "false"]);
    expect(requests.map(({ query }) => query.get("cursor"))).toEqual([null, cursor]);
  });

  it("suppresses a nonempty derived list in quiet mode", async () => {
    response = () => ({
      status: 200,
      body: { items: [{ ...contactGroup, name: "Fixture group" }], nextCursor: null },
    });
    const human = await invoke(["contact-groups", "list"]);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain("Fixture group");
    expect(await invoke(["contact-groups", "list", "--quiet"])).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
    expect(requests).toHaveLength(2);
  });

  it("prints the OAuth continuation URL after the mutation verdict", async () => {
    const authorizationUrl = "https://accounts.example.com/authorize?state=fixture";
    response = () => ({
      status: 201,
      body: { accountId: "intgacct_1234567890abcdef", authorizationUrl },
    });
    const result = await invoke([
      "accounts",
      "connect",
      "--data",
      JSON.stringify({ provider: "google", returnTo: "/dashboard/acme/integrations" }),
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Completed accounts.connect.\n");
    expect(result.stdout).toContain(authorizationUrl);
    expect(requests).toHaveLength(1);
  });

  it("validates inline JSON, a file, and stdin in dry runs without credentials or requests", async () => {
    const path = join(configHome, "contact-group.json");
    const data = JSON.stringify({ name: "Test group", type: "static" });
    await writeFile(path, data);
    for (const source of [data, `@${path}`, "-"]) {
      const result = await runCli(
        ["contact-groups", "create", "--data", source, "--dry-run", "--json"],
        {
          configHome,
          stdin: source === "-" ? data : undefined,
          env: { SAMVA_API_URL: apiUrl },
        },
      );
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        type: "result",
        command: "contact-groups.create",
        data: { dryRun: true, method: "POST", payload: { name: "Test group", type: "static" } },
      });
    }
    expect(requests).toEqual([]);
  });

  it("previews a GET explicitly marked as having side effects", async () => {
    const result = await invoke(["integration-catalog", "search", "--dry-run", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "integration-catalog.search",
      data: { dryRun: true, method: "GET" },
    });
    expect(requests).toEqual([]);
  });

  it("rejects unknown data and refuses destructive execution without --yes before sending", async () => {
    const invalid = await invoke([
      "contact-groups",
      "create",
      "--data",
      '{"name":"Test","type":"static","typo":true}',
      "--json",
    ]);
    expect(invalid.code).toBe(2);
    expect(JSON.parse(invalid.stderr)).toMatchObject({ reason: "invalid_operation_input" });
    const remove = derivedOperations.find(
      ({ operationId }) => operationId === "contactGroups.remove",
    );
    if (remove === undefined) throw new Error("Missing remove operation");
    const declined = await invoke(requestExample(remove).args.filter((arg) => arg !== "--yes"));
    expect(declined.code).toBe(2);
    expect(JSON.parse(declined.stderr)).toMatchObject({ reason: "confirmation_required" });
    expect(requests).toEqual([]);
  });

  it.each([
    [403, 4],
    [504, 124],
  ])("maps a response status of %i to exit %i", async (status, code) => {
    response = () => deny(status);
    const result = await invoke(["contact-groups", "list", "--json"]);
    expect(result.code, result.stderr).toBe(code);
    expect(result.stdout).toBe("");
  });
});
