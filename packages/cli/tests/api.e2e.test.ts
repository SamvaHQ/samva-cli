import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { type IncomingHttpHeaders, createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest";

import { runCli } from "./support/run-cli";

// Never called: puts the spawned entry in this file's import graph for `vitest --changed`.
void (() => import("./oauth-runner.ts"));

// Process-level contract for `samva api`: what reaches the wire for each flag, what reaches stdout
// and stderr, and the exit code. The server records requests and answers from `reply`.

const oauthRunner = fileURLToPath(new URL("./oauth-runner.ts", import.meta.url));
const apiKey = "samva_sk_test_secret_value";

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}
interface Reply {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

let requests: Array<Recorded> = [];
let reply: (request: Recorded) => Reply = () => ({ status: 200, body: "{}" });
let server: Server;
let apiUrl = "";
let home = "";

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "samva-api-"));
  await mkdir(join(home, "samva"));
  await writeFile(
    join(home, "samva", "config.json"),
    JSON.stringify({
      version: 2,
      profiles: { default: { credentialIdentity: "oauth", orgSlug: "acme" } },
    }),
  );
  server = createServer((req, res) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded: Recorded = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      };
      requests.push(recorded);
      const answer = reply(recorded);
      res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP port");
  apiUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  reply = () => ({ status: 200, body: "{}" });
});

const api = (args: ReadonlyArray<string>, stdin?: string) =>
  runCli(["api", ...args], {
    configHome: home,
    env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: apiKey },
    stdin,
  });

const lastBody = () => JSON.parse(requests.at(-1)?.body ?? "null") as unknown;

describe("samva api request", () => {
  it.each(["email/domains", "/email/domains", "/v1/email/domains", "v1/email/domains"])(
    "resolves %s to /v1/email/domains with the API key",
    async (path) => {
      reply = () => ({ status: 200, body: '{"items":[]}' });
      const result = await api([path]);
      expect(result).toMatchObject({ code: 0, stdout: '{"items":[]}', stderr: "" });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ method: "GET", url: "/v1/email/domains", body: "" });
      expect(requests[0]?.headers["x-api-key"]).toBe(apiKey);
      expect(requests[0]?.headers["x-samva-client"]).toMatch(/^cli\//);
      expect(requests[0]?.headers.authorization).toBeUndefined();
    },
  );

  it("sends OAuth as a bearer token with the active organization", async () => {
    const result = await runCli(["--no-env-file", oauthRunner, "api", "messages"], {
      executable: "bun",
      configHome: home,
      env: { SAMVA_API_URL: apiUrl },
    });
    expect(result.code).toBe(0);
    expect(requests[0]?.headers.authorization).toBe("Bearer oauth-test-token");
    expect(requests[0]?.headers["x-org-slug"]).toBe("acme");
    expect(requests[0]?.headers["x-api-key"]).toBeUndefined();
  });

  it("keeps a query string in the path and sends GET fields beside it", async () => {
    await api([
      "email/domains?limit=2",
      "-X",
      "GET",
      "-f",
      "status=ready",
      "-f",
      "tag[]=a",
      "-f",
      "tag[]=b",
    ]);
    expect(requests[0]).toMatchObject({
      method: "GET",
      url: "/v1/email/domains?limit=2&status=ready&tag=a&tag=b",
      body: "",
    });
  });

  it("defaults to POST with a JSON body once a field is given", async () => {
    await api(["webhooks", "-f", "name=orders", "-f", "url=https://example.com/hook"]);
    expect(requests[0]).toMatchObject({ method: "POST", url: "/v1/webhooks" });
    expect(requests[0]?.headers["content-type"]).toBe("application/json");
    expect(lastBody()).toEqual({ name: "orders", url: "https://example.com/hook" });
  });

  it("lets -X choose the method for body fields", async () => {
    await api(["webhooks/wep_1", "-X", "patch", "-f", "name=renamed"]);
    expect(requests[0]).toMatchObject({ method: "PATCH", url: "/v1/webhooks/wep_1" });
    expect(lastBody()).toEqual({ name: "renamed" });
  });

  it("types -F values and keeps -f values as strings", async () => {
    await api([
      "x",
      "-F",
      "on=true",
      "-F",
      "off=false",
      "-F",
      "none=null",
      "-F",
      "count=42",
      "-F",
      "negative=-7",
      "-F",
      "padded=007",
      "-F",
      "word=hello",
      "-f",
      "text=42",
    ]);
    expect(lastBody()).toEqual({
      on: true,
      off: false,
      none: null,
      count: 42,
      negative: -7,
      padded: "007",
      word: "hello",
      text: "42",
    });
  });

  it("nests objects and builds arrays, with a bare key[] as an empty array", async () => {
    await api([
      "x",
      "-f",
      "a[b][c]=1",
      "-F",
      "a[b][d]=2",
      "-f",
      "list[]=x",
      "-F",
      "list[]=3",
      "-f",
      "empty[]",
    ]);
    expect(lastBody()).toEqual({
      a: { b: { c: "1", d: 2 } },
      list: ["x", 3],
      empty: [],
    });
  });

  it("keeps -f and -F in command-line order, so later fields win and arrays append in order", async () => {
    await api([
      "x",
      "-F",
      "count=1",
      "-f",
      "count=2",
      "-F",
      "list[]=3",
      "-f",
      "list[]=x",
      "--raw-field=list[]=y",
    ]);
    expect(lastBody()).toEqual({ count: "2", list: [3, "x", "y"] });
  });

  it("accepts field names that Object.prototype also defines", async () => {
    await api(["x", "-f", "data[constructor][]=a", "-f", "__proto__=b", "-f", "toString=c"]);
    expect(requests[0]?.body).toBe('{"data":{"constructor":["a"]},"__proto__":"b","toString":"c"}');
  });

  it("reads -F values from a file and from stdin", async () => {
    const file = join(home, "value.txt");
    await writeFile(file, "from a file");
    await api(["x", "-F", `note=@${file}`, "-F", "piped=@-"], "from stdin");
    expect(lastBody()).toEqual({ note: "from a file", piped: "from stdin" });
  });

  it("sends --input verbatim as the body and moves fields to the query string", async () => {
    const file = join(home, "body.json");
    await writeFile(file, '{"exact":  "bytes"}');
    await api(["x", "--input", file, "-f", "dryRun=true"]);
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "/v1/x?dryRun=true",
      body: '{"exact":  "bytes"}',
    });
    expect(requests[0]?.headers["content-type"]).toBe("application/json");

    await api(["x", "--input", "-", "-X", "PUT", "-H", "content-type: text/plain"], "raw text");
    expect(requests[1]).toMatchObject({ method: "PUT", body: "raw text" });
    expect(requests[1]?.headers["content-type"]).toBe("text/plain");
  });

  it("adds request headers, and a header replaces a default of the same name", async () => {
    await api(["x", "-H", "Accept: text/csv", "-H", "x-trace: 1"]);
    expect(requests[0]?.headers.accept).toBe("text/csv");
    expect(requests[0]?.headers["x-trace"]).toBe("1");
  });

  it("does not follow redirects, so credentials stay with the API URL", async () => {
    reply = () => ({ status: 302, headers: { location: "http://127.0.0.1:1/elsewhere" } });
    const result = await api(["x"]);
    expect(result.code).toBe(1);
    expect(requests).toHaveLength(1);
  });
});

describe("samva api output", () => {
  it("passes the response body through untouched when stdout is not a terminal", async () => {
    reply = () => ({ status: 200, headers: { "content-type": "text/csv" }, body: "a,b\n1,2" });
    const result = await api(["x"]);
    expect(result).toMatchObject({ code: 0, stdout: "a,b\n1,2", stderr: "" });
  });

  it("prints the status line and headers with -i, and nothing with --silent", async () => {
    reply = () => ({ status: 201, headers: { "x-request-id": "req_1" }, body: '{"ok":true}' });
    const included = await api(["x", "-i"]);
    expect(included.stdout).toMatch(/^HTTP 201 Created\n/);
    expect(included.stdout).toContain("x-request-id: req_1");
    expect(included.stdout.endsWith('\n\n{"ok":true}')).toBe(true);

    const silent = await api(["x", "--silent"]);
    expect(silent).toMatchObject({ code: 0, stdout: "", stderr: "" });
  });

  it("traces the request on stderr with credentials redacted", async () => {
    const result = await api(["x", "-f", "a=1", "-H", "x-session-token: hush", "--verbose"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("{}");
    expect(result.stderr).toContain("> POST /v1/x");
    expect(result.stderr).toContain("< HTTP 200");
    expect(result.stderr).toContain('{"a":"1"}');
    expect(result.stderr).toContain("x-api-key: <redacted>");
    expect(result.stderr).toContain("x-session-token: <redacted>");
    expect(result.stderr).not.toContain(apiKey);
    expect(result.stderr).not.toContain("hush");
  });
});

describe("samva api pagination", () => {
  const pages = (request: Recorded) => {
    const cursor = new URL(request.url, "http://x").searchParams.get("cursor");
    return cursor === null
      ? { status: 200, body: '{"items":[1,2],"nextCursor":"c2"}' }
      : { status: 200, body: '{"items":[3],"nextCursor":null}' };
  };

  it("follows nextCursor and prints each page", async () => {
    reply = pages;
    const result = await api(["things", "--paginate"]);
    expect(result.code).toBe(0);
    expect(requests.map((request) => request.url)).toEqual(["/v1/things", "/v1/things?cursor=c2"]);
    expect(result.stdout).toBe(
      '{"items":[1,2],"nextCursor":"c2"}\n{"items":[3],"nextCursor":null}\n',
    );
  });

  it("keeps the other query parameters on every page, and --slurp prints one array", async () => {
    reply = pages;
    const result = await api(["things?limit=2", "--paginate", "--slurp"]);
    expect(requests.map((request) => request.url)).toEqual([
      "/v1/things?limit=2",
      "/v1/things?limit=2&cursor=c2",
    ]);
    expect(JSON.parse(result.stdout)).toEqual([
      { items: [1, 2], nextCursor: "c2" },
      { items: [3], nextCursor: null },
    ]);
  });

  it("stops with exit 1 and prints no array when a later page fails under --slurp", async () => {
    reply = (request) =>
      request.url.includes("cursor=")
        ? { status: 500, body: '{"_tag":"InternalError","message":"boom"}' }
        : pages(request);
    const result = await api(["things", "--paginate", "--slurp"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("boom");
  });

  it("refuses a repeated cursor instead of looping", async () => {
    reply = () => ({ status: 200, body: '{"items":[],"nextCursor":"same"}' });
    const result = await api(["things", "--paginate"]);
    expect(result.code).toBe(1);
    expect(requests).toHaveLength(2);
    expect(result.stderr).toContain("same nextCursor");
  });
});

describe("samva api failures", () => {
  it.each([
    [401, 4],
    [403, 4],
    [404, 1],
    [422, 1],
    [500, 1],
  ])("writes a %s body to stderr and exits %s", async (status, code) => {
    const body = JSON.stringify({ _tag: "SomeError", message: `status ${status}` });
    reply = () => ({ status, body });
    const result = await api(["x"]);
    expect(result).toMatchObject({ code, stdout: "", stderr: `${body}\n` });
  });

  it("names the status when the failure has no body", async () => {
    reply = () => ({ status: 404 });
    const result = await api(["x"]);
    expect(result).toMatchObject({ code: 1, stdout: "", stderr: "HTTP 404 Not Found\n" });
  });

  it("reports an unreachable API URL as an operational failure", async () => {
    const result = await runCli(["api", "x"], {
      configHome: home,
      env: { SAMVA_API_URL: "http://127.0.0.1:1", SAMVA_API_KEY: apiKey },
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("failed");
  });

  it.each([
    ["an absolute URL", ["https://example.com/v1/x"]],
    ["a missing path", ["/"]],
    ["a field without a value", ["x", "-f", "novalue"]],
    ["a malformed field name", ["x", "-f", "a[b=1"]],
    ["conflicting fields", ["x", "-f", "a=1", "-f", "a[b]=2"]],
    ["a malformed header", ["x", "-H", "nocolon"]],
    ["--slurp without --paginate", ["x", "--slurp"]],
    ["--paginate on a write", ["x", "--paginate", "-X", "POST"]],
    ["--input with GET", ["x", "--input", "-", "-X", "GET"]],
    ["machine output modes", ["x", "--json"]],
    ["an unreadable field file", ["x", "-F", "a=@/nonexistent/file"]],
  ])("rejects %s with exit 2 before any request", async (_name, args) => {
    const result = await api(args, "stdin");
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(requests).toHaveLength(0);
  });

  it("refuses to read standard input twice", async () => {
    const result = await api(["x", "-F", "a=@-", "--input", "-"], "once");
    expect(result.code).toBe(2);
    expect(requests).toHaveLength(0);
  });

  it("fails with exit 4 before any request when no credentials exist", async () => {
    const result = await runCli(["api", "x"], {
      configHome: await mkdtemp(join(tmpdir(), "samva-api-empty-")),
      env: { SAMVA_API_URL: apiUrl },
    });
    expect(result.code).toBe(4);
    expect(requests).toHaveLength(0);
  });
});
