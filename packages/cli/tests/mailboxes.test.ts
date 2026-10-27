import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { Cursor } from "@samva/core/shared/cursor";
import { Predicate, Schema } from "effect";

import { runCli } from "./support/run-cli";

// Never called: puts the spawned entry in this file's import graph for `vitest --changed`.
void (() => import("./oauth-runner.ts"));

const runner = fileURLToPath(new URL("./oauth-runner.ts", import.meta.url));
const mailboxId = "mbx_1234567890123456";
const messageId = "msg_1234567890123456";
const threadId = "thread_1234567890123456";
const actionId = "mbxact_1234567890123456";
const date = "2026-10-06T00:00:00.000Z";
const endpoint = {
  id: "mbxep_1234567890123456",
  channel: "email",
  address: "support@acme.samva.email",
  source: "samvaHosted",
  domainId: null,
  displayName: null,
  default: true,
};
const summary = {
  id: mailboxId,
  namespaceId: null,
  slug: "support",
  name: "Support",
  status: "active",
  primaryAddress: "support@acme.samva.email",
  createdAt: date,
};
const mailbox = {
  ...summary,
  description: null,
  metadata: {},
  endpoints: [endpoint],
  updatedAt: date,
};
const message = {
  id: messageId,
  channel: "email",
  threadId,
  conversationId: "conv_1234567890123456",
  direction: "inbound",
  from: { address: "sender@example.com" },
  recipients: [{ kind: "to", address: "support@example.com" }],
  replyTo: ["reply@example.com"],
  subject: "Invoice",
  text: "Full body with quote",
  replyText: "New text",
  headers: { messageId: "<external@example.com>", inReplyTo: null, references: [] },
  authentication: { spf: "pass", dkim: "fail", dmarc: "pass" },
  attachments: [
    {
      id: "att_1234567890123456",
      filename: "invoice.pdf",
      contentType: "application/pdf",
      size: 1234,
      isInline: false,
    },
  ],
  sentBy: { kind: "user", id: "user_123", displayName: "Reviewer" },
  occurredAt: date,
};
const held = {
  id: messageId,
  disposition: "quarantined",
  reason: "spam",
  source: "receipt",
  from: { address: "sender@example.com", name: null },
  subject: "Invoice",
  receivedAt: date,
  heldAt: date,
  releasedAt: date,
  threadId,
  discardedAt: null,
};
const discarded = { ...held, releasedAt: null, threadId: null, discardedAt: date };
const thread = {
  id: threadId,
  channel: "email",
  endpointId: endpoint.id,
  subject: "Invoice",
  preview: "New text",
  from: { address: "sender@example.com", displayName: null },
  messageCount: 1,
  hasAttachments: false,
  hasDraft: false,
  folder: "inbox",
  priority: "normal",
  labels: [],
  read: false,
  starred: false,
  snoozedUntil: null,
  lastActivityAt: date,
};
const receipt = (
  state: "accepted" | "completed" | "approvalRequired" | "queued" | "notSent" | "uncertain",
) => ({
  actionId,
  messageId: state === "accepted" || state === "completed" ? messageId : null,
  draftId: null,
  threadId,
  state,
  acceptedAt: state === "accepted" || state === "completed" ? date : null,
  executeUntil: null,
  retryAt: null,
  problem: null,
  retryEligible: false,
  decision: null,
  updatedAt: date,
  waitReason: null,
  reviewExpectedAt: null,
  skippedRecipients: [],
  createdAt: date,
});
const cursorAt = (id: string) =>
  Schema.encodeSync(Cursor)({ at: "2026-10-06T00:00:00.000000Z", id });
const action = {
  id: actionId,
  type: "sendMessage",
  state: "approvalRequired",
  source: "humanUi",
  proposedBy: { kind: "user", id: "user_proposer", displayName: "Proposer" },
  threadId,
  draftId: null,
  decision: {
    outcome: "requireApproval",
    reason: "Review first",
    policyId: null,
    source: null,
    decidedAt: date,
  },
  send: receipt("approvalRequired"),
  intent: null,
  resolution: null,
  createdAt: date,
  updatedAt: date,
};
const newScenarios = [
  {
    args: ["get", mailboxId],
    response: mailbox,
    method: "GET",
    path: `/v1/mailboxes/${mailboxId}`,
    human: "Endpoints:",
  },
  {
    args: ["update", mailboxId, "--data", '{"name":"Support"}'],
    response: mailbox,
    method: "PATCH",
    path: `/v1/mailboxes/${mailboxId}`,
    human: "Support",
  },
  {
    args: ["pause", mailboxId],
    response: { ...mailbox, status: "paused" },
    method: "POST",
    path: `/v1/mailboxes/${mailboxId}/pause`,
    human: "paused",
  },
  {
    args: ["resume", mailboxId],
    response: mailbox,
    method: "POST",
    path: `/v1/mailboxes/${mailboxId}/resume`,
    human: "active",
  },
  {
    args: ["actions", "list", mailboxId],
    response: { items: [action], nextCursor: null },
    method: "GET",
    path: `/v1/mailboxes/${mailboxId}/actions`,
    human: "Review first",
  },
  {
    args: ["actions", "approve", mailboxId, actionId, "--yes"],
    response: { ...action, state: "accepted", send: receipt("accepted") },
    method: "POST",
    path: `/v1/mailboxes/${mailboxId}/actions/${actionId}/approve`,
    human: "accepted",
  },
  {
    args: ["actions", "deny", mailboxId, actionId, "--reason", "Wrong recipient", "--yes"],
    response: {
      ...action,
      state: "notSent",
      send: receipt("notSent"),
      resolution: {
        outcome: "denied",
        actor: { kind: "user", id: "user_approver", displayName: "Approver", source: "humanUi" },
        resolvedAt: date,
        reason: "Wrong recipient",
      },
    },
    method: "POST",
    path: `/v1/mailboxes/${mailboxId}/actions/${actionId}/deny`,
    human: "Resolution: denied by Approver — user user_approver (humanUi)",
  },
];
const scenarios = [
  {
    args: ["actions", "get", mailboxId, actionId],
    response: {
      id: actionId,
      type: "sendMessage",
      state: "uncertain",
      source: "externalApi",
      proposedBy: { kind: "apiKey", id: "key" },
      threadId,
      draftId: null,
      decision: null,
      resolution: null,
      createdAt: date,
      updatedAt: date,
      send: receipt("uncertain"),
      intent: null,
    },
    status: 200,
    method: "GET",
    path: `/v1/mailboxes/${mailboxId}/actions/${actionId}`,
    human: "uncertain",
  },

  {
    args: ["actions", "cancel", mailboxId, actionId],
    response: receipt("notSent"),
    status: 202,
    method: "POST",
    path: `/v1/mailboxes/${mailboxId}/actions/${actionId}/cancel`,
    human: "notSent",
  },
  {
    args: ["actions", "retry", mailboxId, actionId],
    response: receipt("queued"),
    status: 202,
    method: "POST",
    path: `/v1/mailboxes/${mailboxId}/actions/${actionId}/retry`,
    human: "queued",
  },

  {
    args: ["create", "--address", "support@example.com", "--name", "Support"],
    response: mailbox,
    status: 201,
    method: "POST",
    path: "/v1/mailboxes",
    human: "Support",
  },
  {
    args: ["threads", mailboxId],
    response: { items: [thread], nextCursor: null },
    status: 200,
    method: "GET",
    path: `/v1/mailboxes/${mailboxId}/threads`,
    human: "Invoice",
  },
  {
    args: ["read", mailboxId, messageId],
    response: message,
    status: 200,
    method: "GET",
    path: `/v1/mailboxes/${mailboxId}/messages/${messageId}`,
    human: "New text",
  },
  {
    args: ["send", mailboxId, "--to", "a@example.com", "--subject", "Hello", "--text", "Hi"],
    response: receipt("accepted"),
    status: 202,
    method: "POST",
    path: `/v1/mailboxes/${mailboxId}/messages`,
    human: messageId,
  },
  {
    args: ["reply", mailboxId, messageId, "--text", "Hi"],
    response: receipt("approvalRequired"),
    status: 202,
    method: "POST",
    path: `/v1/mailboxes/${mailboxId}/messages/${messageId}/reply`,
    human: "approvalRequired",
  },
  {
    args: ["send", mailboxId, "--to", "a@example.com", "--subject", "Hi", "--text", "Hi"],
    response: {
      ...receipt("accepted"),
      skippedRecipients: [
        { address: "gone@example.com", reason: "bounce" },
        {
          address: "optout@example.com",
          reason: "topic-unsubscribe",
          topicId: "unsub_1234567890123456",
        },
      ],
    },
    status: 202,
    method: "POST",
    path: `/v1/mailboxes/${mailboxId}/messages`,
    human: "optout@example.com",
  },
  {
    args: ["reply", mailboxId, messageId, "--text", "Hi"],
    response: {
      ...receipt("accepted"),
      skippedRecipients: [{ address: "gone@example.com", reason: "complaint" }],
    },
    status: 202,
    method: "POST",
    path: `/v1/mailboxes/${mailboxId}/messages/${messageId}/reply`,
    human: "complaint",
  },
  {
    args: ["quarantine", "list", mailboxId],
    response: { items: [held], nextCursor: null },
    status: 200,
    method: "GET",
    path: `/v1/mailboxes/${mailboxId}/quarantine`,
    human: "quarantined",
  },
  {
    args: ["quarantine", "release", mailboxId, messageId],
    response: held,
    status: 200,
    method: "POST",
    path: `/v1/mailboxes/${mailboxId}/messages/${messageId}/release`,
    human: threadId,
  },
];
interface RequestRecord {
  method: string;
  path: string;
  headers: import("node:http").IncomingHttpHeaders;
  body: unknown;
}
let requests: RequestRecord[] = [];
let responses: Array<{ status: number; body?: unknown }> = [];
/** What a GET of the replied-to message answers, outside the scripted responses, when set. */
let repliedMessage: unknown;
let peeks = 0;
const repliedMessagePath = `/v1/mailboxes/${mailboxId}/messages/${messageId}`;
let home: string;
let apiUrl: string;
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (repliedMessage !== undefined && req.method === "GET" && req.url === repliedMessagePath) {
    peeks += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(repliedMessage));
    return;
  }
  requests.push({
    method: req.method!,
    path: req.url!,
    headers: req.headers,
    body: raw ? JSON.parse(raw) : undefined,
  });
  const response = responses.shift();
  res.writeHead(response?.status ?? 500, { "content-type": "application/json" });
  res.end(response?.body === undefined ? "" : JSON.stringify(response.body));
});
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "samva-mailboxes-"));
  await mkdir(join(home, "samva"));
  await writeFile(
    join(home, "samva", "config.json"),
    JSON.stringify({
      version: 2,
      profiles: { default: { credentialIdentity: "oauth", orgSlug: "acme" } },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const serverAddress = server.address();
  if (!serverAddress || typeof serverAddress === "string") throw new Error("Missing HTTP port");
  apiUrl = `http://127.0.0.1:${serverAddress.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(home, { recursive: true });
});
const run = async (args: string[], body: unknown, status?: number, oauth = false) => {
  requests = [];
  peeks = 0;
  repliedMessage = args[0] === "reply" ? message : undefined;
  const responseStatus = status ?? (Predicate.isObject(body) && "actionId" in body ? 202 : 200);
  responses = [{ body, status: responseStatus }];
  return runCli(["--no-env-file", runner, "mailboxes", ...args], {
    executable: "bun",
    configHome: home,
    env: { SAMVA_API_URL: apiUrl, ...(oauth ? {} : { SAMVA_API_KEY: "sk_test_mailbox" }) },
  });
};
const assertRequest = (method: string, path: string, oauth = false) => {
  expect(requests).toHaveLength(1);
  expect(requests[0]?.method).toBe(method);
  expect(requests[0]?.path).toBe(path);
  expect(requests[0]?.headers["x-samva-client"]).toMatch(/^cli\//);
  if (oauth) {
    expect(requests[0]?.headers.authorization).toBe("Bearer oauth-test-token");
    expect(requests[0]?.headers["x-org-slug"]).toBe("acme");
    expect(requests[0]?.headers["x-api-key"]).toBeUndefined();
  } else {
    expect(requests[0]?.headers["x-api-key"]).toBe("sk_test_mailbox");
    expect(requests[0]?.headers.authorization).toBeUndefined();
    expect(requests[0]?.headers["x-org-slug"]).toBeUndefined();
  }
};
describe("mailbox command HTTP contracts", () => {
  for (const scenario of [
    ...scenarios,
    ...newScenarios.map((item) => ({ ...item, status: 200 })),
  ]) {
    it(`forwards OAuth credentials for ${scenario.args.join(" ")}`, async () => {
      const result = await run(
        [...scenario.args, "--json"],
        scenario.response,
        scenario.status,
        true,
      );
      expect(result.code, result.stderr).toBe(0);
      assertRequest(scenario.method, scenario.path, true);
      expect(JSON.parse(result.stdout)).toEqual(scenario.response);
    });
    it(`renders human output for ${scenario.args.join(" ")}`, async () => {
      const result = await run(scenario.args, scenario.response, scenario.status, true);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain(scenario.human);
      expect(result.stderr).toBe("");
    });
  }
  for (const scenario of newScenarios) {
    it(`keeps API key denial guidance for ${scenario.args.slice(0, 2).join(" ")}`, async () => {
      const result = await run(
        [...scenario.args, "--json"],
        { _tag: "ForbiddenError", message: "Missing authority" },
        403,
      );
      expect(result.code, result.stderr).toBe(4);
      assertRequest(scenario.method, scenario.path);
      const error = JSON.parse(result.stderr);
      expect(error).toMatchObject({ reason: "ForbiddenError", status: 403 });
      expect(error.next).toContain(
        scenario.args[0] === "actions" && scenario.args[1] !== "list"
          ? "samva login"
          : "required scope",
      );
      expect(result.stdout).toBe("");
    });
  }
  for (const refusal of [
    {
      body: { _tag: "RateLimitedError", message: "Too many sends", retryAfterSeconds: 17 },
      status: 429,
      exit: 1,
      next: "Wait 17 seconds before retrying.",
    },
    {
      body: {
        _tag: "SenderNotReadyError",
        message: "Sender is getting ready",
        sender: "support@acme.samva.email",
        retryAfterSeconds: 23,
      },
      status: 503,
      exit: 1,
      next: "Wait 23 seconds before retrying.",
    },
    {
      body: {
        _tag: "SenderNotReadyError",
        message: "Sender is getting ready",
        sender: "support@acme.samva.email",
      },
      status: 503,
      exit: 1,
      next: "Wait for the sending identity to be ready before retrying.",
    },
    {
      body: {
        _tag: "OnboardingReviewRequiredError",
        message: "Review required",
        code: "review_required",
        stage: "manual_review",
        decision: "undecided",
        nextAction: "wait_for_review",
      },
      status: 403,
      exit: 4,
      next: "wait_for_review",
    },
  ]) {
    for (const args of [
      ["send", mailboxId, "--to", "a@example.com", "--subject", "Hello", "--text", "Hi"],
      ["actions", "approve", mailboxId, actionId, "--yes"],
    ]) {
      it(`preserves ${refusal.body._tag} recovery fields for ${args[0]} with ${refusal.next}`, async () => {
        const result = await run([...args, "--json"], refusal.body, refusal.status, true);
        expect(result.code, result.stderr).toBe(refusal.exit);
        expect(result.stdout).toBe("");
        const { _tag, message: errorMessage, ...details } = refusal.body;
        expect(JSON.parse(result.stderr)).toMatchObject({
          reason: _tag,
          status: refusal.status,
          message: errorMessage,
          details,
          next: refusal.next,
        });
        const human = await run(args, refusal.body, refusal.status, true);
        expect(human.code, human.stderr).toBe(refusal.exit);
        expect(human.stderr).toContain(errorMessage);
        expect(human.stderr).toContain(refusal.next);
      });
    }
  }
  it("forwards a schema-checked settings patch without losing null metadata keys", async () => {
    const patch = {
      name: "Inbox",
      metadata: { purpose: "support", obsolete: null },
    };
    const result = await run(
      ["update", mailboxId, "--data", JSON.stringify(patch), "--json"],
      mailbox,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(requests[0]?.body).toEqual(patch);
  });
  for (const data of [
    "invalid",
    "[]",
    "{}",
    '{"description":"unsupported"}',
    '{"defaultFrom":{"address":"a@example.com"}}',
    '{"name":""}',
  ]) {
    it(`rejects invalid update data before making a request: ${data}`, async () => {
      const result = await run(["update", mailboxId, "--data", data, "--json"], undefined);
      expect(result.code).toBe(2);
      expect(requests).toHaveLength(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("mailbox_update_");
    });
  }
  it("reads mailbox update patches from @file", async () => {
    const path = join(home, "patch.json");
    await writeFile(path, '{"name":"From file"}');
    const result = await run(["update", mailboxId, "--data", `@${path}`, "--json"], mailbox);
    expect(result.code, result.stderr).toBe(0);
    expect(requests[0]?.body).toEqual({ name: "From file" });
  });
  for (const data of ["@", "@/missing/mailbox-patch.json"]) {
    it(`rejects unavailable update file ${data}`, async () => {
      const result = await run(["update", mailboxId, "--data", data, "--json"], undefined);
      expect(result.code).toBe(2);
      expect(requests).toHaveLength(0);
      expect(result.stderr).toContain(data === "@" ? "missing_data_file" : "data_file_unreadable");
    });
  }
  it("previews settings without making a request", async () => {
    const result = await run(
      ["update", mailboxId, "--data", '{"name":"Inbox"}', "--dry-run", "--json"],
      undefined,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(requests).toHaveLength(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      request: { name: "Inbox" },
    });
  });
  it("forwards action state and time filters", async () => {
    const result = await run(
      [
        "actions",
        "list",
        mailboxId,
        "--state",
        "approvalRequired",
        "--limit",
        "5",
        "--after",
        date,
        "--json",
      ],
      { items: [action], nextCursor: null },
    );
    expect(result.code, result.stderr).toBe(0);
    const url = new URL(requests[0]!.path, apiUrl);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      state: "approvalRequired",
      limit: "5",
      after: date,
    });
  });
  for (const verb of ["approve", "deny"]) {
    it(`prints person and different-proposer guidance in human mode for ${verb}`, async () => {
      const result = await run(
        ["actions", verb, mailboxId, actionId, "--yes"],
        { _tag: "ForbiddenError", message: "A different person must review this action" },
        403,
      );
      expect(result.code, result.stderr).toBe(4);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("samva login");
      expect(result.stderr).toContain("different from its proposer");
      expect(result.stderr).toContain(`cannot ${verb}`);
    });
  }
  it("streams paged actions with JSONL", async () => {
    requests = [];
    responses = [
      { status: 200, body: { items: [action], nextCursor: cursorAt(actionId) } },
      {
        status: 200,
        body: {
          items: [
            {
              ...action,
              id: "mbxact_6543210987654321",
              send: { ...action.send, actionId: "mbxact_6543210987654321" },
            },
          ],
          nextCursor: null,
        },
      },
    ];
    const result = await runCli(
      [
        "--no-env-file",
        runner,
        "mailboxes",
        "actions",
        "list",
        mailboxId,
        "--state",
        "approvalRequired",
        "--all",
        "--jsonl",
      ],
      {
        executable: "bun",
        configHome: home,
        env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "sk_test_mailbox" },
      },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).data.id),
    ).toEqual([actionId, "mbxact_6543210987654321"]);
    const next = new URL(requests[1]!.path, apiUrl);
    expect(Object.fromEntries(next.searchParams)).toEqual({
      state: "approvalRequired",
      cursor: cursorAt(actionId),
    });
  });
  it("sends the denial reason to the API", async () => {
    const result = await run(
      ["actions", "deny", mailboxId, actionId, "--reason", "Wrong recipient", "--yes", "--json"],
      { ...action, state: "notSent", send: receipt("notSent") },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(requests[0]?.body).toEqual({ reason: "Wrong recipient" });
  });
  it("supplies a clear default denial reason when omitted", async () => {
    const result = await run(["actions", "deny", mailboxId, actionId, "--yes", "--json"], {
      ...action,
      state: "notSent",
      send: receipt("notSent"),
    });
    expect(result.code, result.stderr).toBe(0);
    expect(requests[0]?.body).toEqual({ reason: "Denied by reviewer." });
  });
  for (const args of [
    ["actions", "approve", mailboxId, actionId],
    ["actions", "deny", mailboxId, actionId],
    ["quarantine", "discard", mailboxId, messageId],
  ]) {
    it(`requires confirmation for ${args.slice(0, 2).join(" ")}`, async () => {
      const result = await run([...args, "--json"], undefined);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("confirmation_required");
      expect(requests).toHaveLength(0);
    });
    it(`previews ${args.slice(0, 2).join(" ")} without making a request`, async () => {
      const result = await run([...args, "--dry-run", "--json"], undefined);
      expect(result.code, result.stderr).toBe(0);
      expect(requests).toHaveLength(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true });
    });
  }
  it("shows all mailbox settings in human output", async () => {
    const data = {
      ...mailbox,
      description: "Support desk",
      endpoints: [{ ...endpoint, displayName: "Customer Care" }],
      metadata: { purpose: "support" },
    };
    const result = await run(["get", mailboxId], data);
    expect(result.code, result.stderr).toBe(0);
    for (const fact of [
      endpoint.address,
      "Customer Care",
      "email:",
      "default",
      "Support desk",
      "samvaHosted",
      "active",
      date,
      "purpose",
    ])
      expect(result.stdout).toContain(fact);
    expect(result.stdout).not.toContain("[object Object]");
  });
  it("shows thread folder, labels, flags and activity for humans", async () => {
    const result = await run(["threads", mailboxId], {
      items: [{ ...thread, labels: ["label_1234567890123456"], starred: true }],
      nextCursor: cursorAt(threadId),
    });
    expect(result.code, result.stderr).toBe(0);
    for (const fact of [
      "inbox",
      "normal",
      "label_1234567890123456",
      "Starred",
      "true",
      "Read",
      "false",
      date,
      cursorAt(threadId),
    ])
      expect(result.stdout).toContain(fact);
  });
  it("preserves attachment, authentication, actor and full content details under the trust notice", async () => {
    const data = {
      ...message,
      html: "<p>Full HTML body</p>",
      recipients: [
        {
          kind: "bcc",
          address: "private@example.com",
          actor: { kind: "user", id: "recipient_user" },
        },
      ],
    };
    const result = await run(["read", mailboxId, messageId], data);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.split("\n")[0]).toContain("untrusted");
    for (const fact of [
      "invoice.pdf",
      "application/pdf",
      "1234",
      "inline",
      "false",
      "SPF",
      "pass",
      "fail",
      "Reviewer",
      "bcc",
      "private@example.com",
      "recipient_user",
      "Full body with quote",
      "Full HTML body",
      "New text",
    ])
      expect(result.stdout).toContain(fact);
  });
  for (const command of ["send", "reply"]) {
    it(`shows ${command} delivery waits independent of acceptance status`, async () => {
      const args =
        command === "send"
          ? [
              "send",
              mailboxId,
              "--to",
              "recipient@example.com",
              "--subject",
              "Hello",
              "--text",
              "Hi",
            ]
          : ["reply", mailboxId, messageId, "--text", "Hi"];
      const data = {
        ...receipt("accepted"),
        waitReason: "content-review",
        reviewExpectedAt: date,
        skippedRecipients: [{ address: "blocked@example.com", reason: "bounce" }],
      };
      const result = await run(args, data);
      expect(result.code, result.stderr).toBe(0);
      for (const fact of [
        "Send accepted",
        "Wait reason",
        "content-review",
        "Review expected at",
        date,
        "blocked@example.com",
        "bounce",
        actionId,
      ])
        expect(result.stdout).toContain(fact);
    });
  }
  it("keeps quarantine metadata and terminal result times in human output", async () => {
    const result = await run(
      ["quarantine", "discard", mailboxId, messageId, "--yes"],
      discarded,
      200,
      true,
    );
    expect(result.code, result.stderr).toBe(0);
    for (const fact of [
      "quarantined",
      "spam",
      "receipt",
      "sender@example.com",
      "Received at",
      "Held at",
      "Discarded at",
      date,
      "Thread",
      "none",
    ])
      expect(result.stdout).toContain(fact);
  });
  for (const oauth of [false, true]) {
    it(`lists readable mailboxes with ${oauth ? "OAuth" : "an API key"}`, async () => {
      const page = { items: [summary], nextCursor: null };
      const result = await run(["list", "--json"], page, 200, oauth);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(page);
      assertRequest("GET", "/v1/mailboxes", oauth);
    });
  }
  it("creates a mailbox from one address, with an optional slug and namespace", async () => {
    const response = mailbox;
    const result = await run(
      [
        "create",
        "--address",
        "support@example.com",
        "--name",
        "Support",
        "--slug",
        "support-team",
        "--namespace",
        "ns_1234567890123456",
        "--json",
      ],
      response,
      201,
    );
    expect(result.code, result.stderr).toBe(0);
    assertRequest("POST", "/v1/mailboxes");
    expect(requests[0]?.body).toEqual({
      endpoint: { channel: "email", address: "support@example.com" },
      name: "Support",
      slug: "support-team",
      namespaceId: "ns_1234567890123456",
    });
    expect(JSON.parse(result.stdout)).toEqual(response);
  });
  it("leaves the slug to the server when none is given", async () => {
    const result = await run(
      ["create", "--address", "support@example.com", "--name", "Support", "--json"],
      mailbox,
      201,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(requests[0]?.body).toEqual({
      endpoint: { channel: "email", address: "support@example.com" },
      name: "Support",
    });
  });
  it("adds an email endpoint to a mailbox", async () => {
    const result = await run(
      [
        "endpoints",
        "add",
        mailboxId,
        "--address",
        "billing@acme.samva.email",
        "--display-name",
        "Billing",
        "--json",
      ],
      mailbox,
      201,
    );
    expect(result.code, result.stderr).toBe(0);
    assertRequest("POST", `/v1/mailboxes/${mailboxId}/endpoints`);
    expect(requests[0]?.body).toEqual({
      channel: "email",
      address: "billing@acme.samva.email",
      displayName: "Billing",
    });
    expect(JSON.parse(result.stdout)).toEqual(mailbox);
  });
  it("updates an endpoint's sender name and default", async () => {
    const named = await run(
      [
        "endpoints",
        "update",
        mailboxId,
        endpoint.id,
        "--display-name",
        "Billing",
        "--default",
        "--json",
      ],
      mailbox,
    );
    expect(named.code, named.stderr).toBe(0);
    assertRequest("PATCH", `/v1/mailboxes/${mailboxId}/endpoints/${endpoint.id}`);
    expect(requests[0]?.body).toEqual({ displayName: "Billing", default: true });
    expect(JSON.parse(named.stdout)).toEqual(mailbox);
    requests.length = 0;
    const cleared = await run(
      ["endpoints", "update", mailboxId, endpoint.id, "--clear-display-name", "--json"],
      mailbox,
    );
    expect(cleared.code, cleared.stderr).toBe(0);
    expect(requests[0]?.body).toEqual({ displayName: null });
  });
  it("refuses an empty or contradictory endpoint update", async () => {
    for (const extra of [[], ["--display-name", "A", "--clear-display-name"]]) {
      const result = await run(
        ["endpoints", "update", mailboxId, endpoint.id, ...extra, "--json"],
        undefined,
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("endpoint_update");
    }
    expect(requests).toHaveLength(0);
  });
  it("previews endpoint changes without a request", async () => {
    const added = await run(
      ["endpoints", "add", mailboxId, "--address", "a@example.com", "--dry-run", "--json"],
      undefined,
    );
    expect(added.code, added.stderr).toBe(0);
    expect(JSON.parse(added.stdout)).toMatchObject({
      dryRun: true,
      action: "mailboxes.createEndpoint",
    });
    const updated = await run(
      ["endpoints", "update", mailboxId, endpoint.id, "--default", "--dry-run", "--json"],
      undefined,
    );
    expect(updated.code, updated.stderr).toBe(0);
    expect(JSON.parse(updated.stdout)).toMatchObject({
      dryRun: true,
      action: "mailboxes.updateEndpoint",
      endpointId: endpoint.id,
      request: { default: true },
    });
    const removed = await run(
      ["endpoints", "remove", mailboxId, endpoint.id, "--dry-run", "--json"],
      undefined,
    );
    expect(removed.code, removed.stderr).toBe(0);
    expect(JSON.parse(removed.stdout)).toMatchObject({
      dryRun: true,
      action: "mailboxes.removeEndpoint",
      endpointId: endpoint.id,
    });
    expect(requests).toHaveLength(0);
  });
  it("removes an endpoint with --yes and refuses without it outside a terminal", async () => {
    const refused = await run(["endpoints", "remove", mailboxId, endpoint.id, "--json"], undefined);
    expect(refused.code).toBe(2);
    expect(requests).toHaveLength(0);
    const result = await run(
      ["endpoints", "remove", mailboxId, endpoint.id, "--yes", "--json"],
      mailbox,
    );
    expect(result.code, result.stderr).toBe(0);
    assertRequest("DELETE", `/v1/mailboxes/${mailboxId}/endpoints/${endpoint.id}`);
    expect(JSON.parse(result.stdout)).toEqual(mailbox);
  });
  it("removes a mailbox with --yes", async () => {
    const response = { success: true };
    const result = await run(["remove", mailboxId, "--yes", "--json"], response, 200, true);
    expect(result.code, result.stderr).toBe(0);
    assertRequest("DELETE", `/v1/mailboxes/${mailboxId}`, true);
    expect(JSON.parse(result.stdout)).toEqual(response);
  });
  it("tells a person the received messages stay after a removal", async () => {
    const result = await run(["remove", mailboxId, "--yes"], { success: true });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Removed mailbox ${mailboxId}.`);
  });
  it("previews a removal without calling the API", async () => {
    const result = await run(["remove", mailboxId, "--dry-run", "--json"], undefined);
    expect(result.code, result.stderr).toBe(0);
    expect(requests).toHaveLength(0);
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: true,
      action: "mailboxes.remove",
      id: mailboxId,
    });
  });
  it("refuses an unconfirmed removal in non-interactive mode", async () => {
    const result = await run(["remove", mailboxId, "--json"], undefined);
    expect(result.code).toBe(2);
    expect(requests).toHaveLength(0);
    expect(result.stderr).toContain("confirmation_required");
  });
  it("forwards thread filters and cursor", async () => {
    const cursor = cursorAt(threadId);
    const response = { items: [], nextCursor: cursorAt("thread_6543210987654321") };
    const result = await run(
      [
        "threads",
        mailboxId,
        "--query",
        "invoice",
        "--folder",
        "inbox",
        "--label",
        "label_1234567890123456",
        "--unread",
        "--limit",
        "10",
        "--cursor",
        cursor,
        "--json",
      ],
      response,
    );
    expect(result.code, result.stderr).toBe(0);
    const url = new URL(requests[0]!.path, apiUrl);
    expect(url.pathname).toBe(`/v1/mailboxes/${mailboxId}/threads`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "invoice",
      folder: "inbox",
      label: "label_1234567890123456",
      unread: "true",
      limit: "10",
      cursor,
    });
    expect(JSON.parse(result.stdout)).toEqual(response);
  });
  it("requires JSONL before unbounded thread traversal", async () => {
    const result = await run(["threads", mailboxId, "--all", "--json"], {});
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("all_requires_jsonl");
    expect(result.stdout).toBe("");
    expect(requests).toHaveLength(0);
  });
  it("streams thread pages with JSONL", async () => {
    requests = [];
    responses = [
      { status: 200, body: { items: [thread], nextCursor: cursorAt(threadId) } },
      { status: 200, body: { items: [thread], nextCursor: null } },
    ];
    const result = await runCli(
      ["--no-env-file", runner, "mailboxes", "threads", mailboxId, "--all", "--jsonl"],
      {
        executable: "bun",
        configHome: home,
        env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "sk_test_mailbox" },
      },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).data),
    ).toEqual([thread, thread]);
    expect(requests[1]?.path).toBe(
      `/v1/mailboxes/${mailboxId}/threads?cursor=${cursorAt(threadId)}`,
    );
  });
  it("reads the complete message as JSON", async () => {
    const result = await run(["read", mailboxId, messageId, "--json"], message);
    expect(result.code, result.stderr).toBe(0);
    assertRequest("GET", `/v1/mailboxes/${mailboxId}/messages/${messageId}`);
    expect(JSON.parse(result.stdout)).toEqual(message);
    expect(result.stdout).not.toContain("untrusted");
  });
  it("puts the untrusted notice before headers and reply text", async () => {
    const result = await run(["read", mailboxId, messageId], message);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.split("\n")[0]).toContain("untrusted email from outside the organization");
    expect(result.stdout).toContain("sender@example.com");
    expect(result.stdout).toContain("<external@example.com>");
    expect(result.stdout).toContain("New text");
    expect(result.stdout).toContain("Full body with quote");
  });
  it("sends recipient arrays and forwards the idempotency header", async () => {
    const response = receipt("approvalRequired");
    const result = await run(
      [
        "send",
        mailboxId,
        "--to",
        "a@example.com",
        "--to",
        "b@example.com",
        "--cc",
        "c@example.com",
        "--bcc",
        "d@example.com",
        "--subject",
        "Hello",
        "--text",
        "Hi",
        "--idempotency-key",
        "send-1",
        "--json",
      ],
      response,
    );
    expect(result.code, result.stderr).toBe(0);
    assertRequest("POST", `/v1/mailboxes/${mailboxId}/messages`);
    expect(requests[0]?.headers["idempotency-key"]).toBe("send-1");
    expect(requests[0]?.body).toEqual({
      to: ["a@example.com", "b@example.com"],
      cc: ["c@example.com"],
      bcc: ["d@example.com"],
      subject: "Hello",
      text: "Hi",
    });
    expect(JSON.parse(result.stdout)).toEqual(response);
  });
  for (const all of [false, true]) {
    it(`replies${all ? " to all" : " to sender"} with HTML`, async () => {
      const response = receipt("accepted");
      const result = await run(
        [
          "reply",
          mailboxId,
          messageId,
          "--html",
          "<p>Thanks</p>",
          "--idempotency-key",
          "reply-1",
          ...(all ? ["--all"] : []),
          "--json",
        ],
        response,
      );
      expect(result.code, result.stderr).toBe(0);
      assertRequest(
        "POST",
        `/v1/mailboxes/${mailboxId}/messages/${messageId}/${all ? "reply-all" : "reply"}`,
      );
      expect(requests[0]?.headers["idempotency-key"]).toBe("reply-1");
      expect(requests[0]?.body).toEqual({ html: "<p>Thanks</p>" });
      expect(JSON.parse(result.stdout)).toEqual(response);
    });
  }
  it("reads an accepted same-key replay returned with HTTP 200", async () => {
    const response = receipt("accepted");
    const result = await run(
      [
        "send",
        mailboxId,
        "--to",
        "a@example.com",
        "--subject",
        "Replay",
        "--text",
        "Same content",
        "--idempotency-key",
        "original-key",
        "--json",
      ],
      response,
      200,
    );
    expect(result.code, result.stderr).toBe(0);
    assertRequest("POST", `/v1/mailboxes/${mailboxId}/messages`);
    expect(requests[0]?.headers["idempotency-key"]).toBe("original-key");
    expect(JSON.parse(result.stdout)).toEqual(response);
  });
  it("prints send status and IDs for humans", async () => {
    const result = await run(
      ["send", mailboxId, "--to", "a@example.com", "--subject", "Hello", "--html", "<p>Hi</p>"],
      receipt("approvalRequired"),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("approvalRequired");
    expect(result.stdout).toContain(threadId);
    expect(result.stdout).toContain(actionId);
  });
  for (const args of [[], ["--text", "a", "--html", "b"]]) {
    it(`rejects invalid reply bodies: ${JSON.stringify(args)}`, async () => {
      const result = await run(["reply", mailboxId, messageId, ...args], {});
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("mailbox_body_required");
      expect(requests).toHaveLength(0);
    });
  }
  it("lists quarantine with pagination and a held-time range", async () => {
    const response = { items: [held], nextCursor: cursorAt(messageId) };
    const result = await run(
      [
        "quarantine",
        "list",
        mailboxId,
        "--limit",
        "5",
        "--cursor",
        cursorAt(messageId),
        "--after",
        "2026-10-01T00:00:00.000Z",
        "--json",
      ],
      response,
    );
    expect(result.code, result.stderr).toBe(0);
    assertRequest(
      "GET",
      `/v1/mailboxes/${mailboxId}/quarantine?limit=5&cursor=${cursorAt(messageId)}&after=2026-10-01T00%3A00%3A00.000Z`,
    );
    expect(JSON.parse(result.stdout)).toEqual(response);
  });
  it("releases with OAuth and leaves authorization to the API", async () => {
    const result = await run(
      ["quarantine", "release", mailboxId, messageId, "--json"],
      held,
      200,
      true,
    );
    expect(result.code, result.stderr).toBe(0);
    assertRequest("POST", `/v1/mailboxes/${mailboxId}/messages/${messageId}/release`, true);
    expect(JSON.parse(result.stdout)).toEqual(held);
  });
  const envelope = (stderr: string) => JSON.parse(stderr);
  it("preserves the encoded accepted receipt when cancellation loses", async () => {
    const accepted = receipt("accepted");
    const result = await run(
      ["actions", "cancel", mailboxId, actionId, "--json"],
      {
        _tag: "MailboxSendConflictError",
        message: "Already accepted",
        resource: "mailbox-action",
        id: actionId,
        receipt: accepted,
      },
      409,
    );
    expect(result.code).toBe(1);
    const error = envelope(result.stderr);
    expect(error).toMatchObject({
      reason: "MailboxSendConflictError",
      status: 409,
      details: { receipt: accepted },
    });
    expect(error.next).toContain("actions get");
    expect(error.next).not.toMatch(/use a new|use another|different key/i);
    assertRequest("POST", `/v1/mailboxes/${mailboxId}/actions/${actionId}/cancel`);
  });
  for (const operation of ["cancel", "retry"]) {
    it(`tells an API key holder ${operation} requires a person without replacement-send advice`, async () => {
      const result = await run(
        ["actions", operation, mailboxId, actionId, "--json"],
        { _tag: "ForbiddenError", message: "A person is required" },
        403,
      );
      expect(result.code).toBe(4);
      assertRequest("POST", `/v1/mailboxes/${mailboxId}/actions/${actionId}/${operation}`);
      expect(envelope(result.stderr).next).toContain("samva login");
      expect(result.stderr).not.toMatch(/new key|different key|fresh key/i);
      expect(result.stdout).toBe("");
    });
  }
  it("tells an API key holder that release needs a person", async () => {
    const result = await run(
      ["quarantine", "release", mailboxId, messageId, "--json"],
      { _tag: "ForbiddenError", message: "API keys cannot release" },
      403,
    );
    expect(result.code, result.stderr).toBe(4);
    assertRequest("POST", `/v1/mailboxes/${mailboxId}/messages/${messageId}/release`);
    const error = envelope(result.stderr);
    expect(error).toMatchObject({
      type: "error",
      reason: "ForbiddenError",
      status: 403,
      message: "API keys cannot release",
    });
    expect(error.next).toContain("samva login");
    expect(error.next).toContain("API key");
    expect(result.stdout).toBe("");
  });
  it("discards with OAuth and leaves authorization to the API", async () => {
    const result = await run(
      ["quarantine", "discard", mailboxId, messageId, "--yes", "--json"],
      discarded,
      200,
      true,
    );
    expect(result.code, result.stderr).toBe(0);
    assertRequest("POST", `/v1/mailboxes/${mailboxId}/messages/${messageId}/discard`, true);
    expect(JSON.parse(result.stdout)).toEqual(discarded);
  });
  it("tells an API key that only a person can discard", async () => {
    const result = await run(
      ["quarantine", "discard", mailboxId, messageId, "--yes", "--json"],
      { _tag: "ForbiddenError", message: "API keys cannot discard" },
      403,
    );
    expect(result.code, result.stderr).toBe(4);
    assertRequest("POST", `/v1/mailboxes/${mailboxId}/messages/${messageId}/discard`);
    const error = envelope(result.stderr);
    expect(error).toMatchObject({ reason: "ForbiddenError", status: 403 });
    expect(error.next).toContain("samva login");
    expect(error.next).toContain("cannot discard");
    expect(result.stdout).toBe("");
  });
  it("keeps the generic forbidden guidance outside release", async () => {
    const result = await run(
      ["list", "--json"],
      { _tag: "ForbiddenError", message: "Missing scope" },
      403,
    );
    expect(result.code, result.stderr).toBe(4);
    expect(envelope(result.stderr).next).toContain("required scope");
  });
  it("exits 4 on an unauthorized credential", async () => {
    const result = await run(
      ["threads", mailboxId, "--json"],
      { _tag: "UnauthorizedError", message: "Invalid API key" },
      401,
    );
    expect(result.code, result.stderr).toBe(4);
    expect(envelope(result.stderr)).toMatchObject({ reason: "UnauthorizedError", status: 401 });
  });
  it("explains the mailbox launch flag for the gate's empty 404", async () => {
    const result = await run(["list", "--json"], undefined, 404);
    expect(result.code).toBe(1);
    const error = envelope(result.stderr);
    expect(error).toMatchObject({
      reason: "FlagDisabledError",
      status: 404,
      details: {},
      message: "Could not list mailboxes: mailboxes are not enabled for this organization.",
    });
    expect(error.next).toContain("`mailbox` launch flag");
    expect(result.stdout).toBe("");
  });
  it("passes a typed 404 through with the API's guidance", async () => {
    const body = {
      _tag: "ResourceNotFoundError",
      message: "Mailbox not found. List mailboxes with mailboxes.list.",
      resource: "mailbox",
      id: mailboxId,
    };
    const result = await run(["read", mailboxId, messageId, "--json"], body, 404);
    expect(result.code).toBe(1);
    const error = envelope(result.stderr);
    expect(error).toMatchObject({
      reason: "ResourceNotFoundError",
      status: 404,
      message: body.message,
      details: { resource: "mailbox", id: mailboxId },
    });
    expect(error.next).toContain("List the resource");
  });
  it("carries validation fields and the next step", async () => {
    const body = {
      _tag: "ValidationError",
      message: "Invalid mailbox",
      fields: { slug: ["Slug is taken"] },
    };
    const result = await run(
      ["create", "--address", "a@example.com", "--name", "Support", "--slug", "support", "--json"],
      body,
      422,
    );
    expect(result.code).toBe(1);
    expect(envelope(result.stderr)).toMatchObject({
      reason: "ValidationError",
      status: 422,
      details: { fields: { slug: ["Slug is taken"] } },
      next: "Fix the listed fields before retrying.",
    });
  });
  it("reports idempotency conflicts with the generic conflict guidance", async () => {
    const result = await run(
      ["reply", mailboxId, messageId, "--text", "Hi", "--idempotency-key", "conflict", "--json"],
      { _tag: "ConflictError", message: "Different body", resource: "mailbox-send" },
      409,
    );
    expect(result.code).toBe(1);
    expect(envelope(result.stderr)).toMatchObject({
      reason: "ConflictError",
      status: 409,
      message: "Different body",
      details: { resource: "mailbox-send" },
    });
    expect(result.stdout).toBe("");
  });
  const stream = async (args: string[], pages: unknown[]) => {
    requests = [];
    responses = pages.map((body) => ({ status: 200, body }));
    const result = await runCli(["--no-env-file", runner, "mailboxes", ...args, "--jsonl"], {
      executable: "bun",
      configHome: home,
      env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "sk_test_mailbox" },
    });
    return {
      ...result,
      items: result.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line).data),
    };
  };
  it("streams every mailbox page with --all and a creation window", async () => {
    const result = await stream(
      [
        "list",
        "--all",
        "--limit",
        "1",
        "--after",
        "2026-10-01T00:00:00Z",
        "--before",
        "2026-10-07T00:00:00Z",
      ],
      [
        { items: [summary], nextCursor: cursorAt(mailboxId) },
        { items: [summary], nextCursor: null },
      ],
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.items).toEqual([summary, summary]);
    expect(requests).toHaveLength(2);
    const first = new URL(requests[0]!.path, apiUrl);
    expect(first.pathname).toBe("/v1/mailboxes");
    expect(Object.fromEntries(first.searchParams)).toEqual({
      limit: "1",
      after: "2026-10-01T00:00:00.000Z",
      before: "2026-10-07T00:00:00.000Z",
    });
    expect(new URL(requests[1]!.path, apiUrl).searchParams.get("cursor")).toBe(cursorAt(mailboxId));
  });
  it("prints the next cursor for humans", async () => {
    const result = await run(["list"], { items: [summary], nextCursor: cursorAt(mailboxId) });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Support");
    expect(result.stdout).toContain(`Next cursor  ${cursorAt(mailboxId)}`);
  });
  it("rejects an invalid mailbox date before calling the API", async () => {
    const result = await run(["list", "--after", "yesterday-ish"], {});
    expect(result.code).toBe(2);
    expect(requests).toHaveLength(0);
  });
  it("stops --all when the API repeats a cursor", async () => {
    const result = await stream(
      ["list", "--all"],
      [
        { items: [summary], nextCursor: cursorAt(mailboxId) },
        { items: [summary], nextCursor: cursorAt(mailboxId) },
      ],
    );
    expect(result.code).toBe(1);
    expect(result.items).toHaveLength(2);
    expect(result.stderr).toContain("repeated a pagination cursor");
  });
  it("forwards the thread activity window and starred filter", async () => {
    const result = await run(
      [
        "threads",
        mailboxId,
        "--starred",
        "--after",
        "2026-10-01T00:00:00Z",
        "--before",
        "2026-10-07T12:30:00Z",
        "--json",
      ],
      { items: [], nextCursor: null },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(Object.fromEntries(new URL(requests[0]!.path, apiUrl).searchParams)).toEqual({
      starred: "true",
      after: "2026-10-01T00:00:00.000Z",
      before: "2026-10-07T12:30:00.000Z",
    });
  });
  it("streams every quarantine page with --all", async () => {
    const result = await stream(
      ["quarantine", "list", mailboxId, "--all"],
      [
        { items: [held], nextCursor: cursorAt(messageId) },
        { items: [held], nextCursor: null },
      ],
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.items).toEqual([held, held]);
    expect(requests.map((request) => request.path)).toEqual([
      `/v1/mailboxes/${mailboxId}/quarantine`,
      `/v1/mailboxes/${mailboxId}/quarantine?cursor=${cursorAt(messageId)}`,
    ]);
  });
  it("requires JSONL before unbounded quarantine traversal", async () => {
    const result = await run(["quarantine", "list", mailboxId, "--all"], {});
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("all_requires_jsonl");
    expect(requests).toHaveLength(0);
  });
});

describe("mailbox commands on phone channels", () => {
  const templateId = "tmpl_1234567890123456";
  const whatsappEndpoint = {
    id: "mbxep_2234567890123456",
    channel: "whatsapp",
    address: "+14155550123",
    displayName: null,
    default: true,
    businessAccountId: "waba_1234567890123456",
  };
  const whatsappMailbox = { ...mailbox, endpoints: [endpoint, whatsappEndpoint] };
  const chatMessage = {
    id: messageId,
    channel: "whatsapp",
    threadId,
    conversationId: "conv_1234567890123456",
    direction: "inbound",
    from: { address: "+14155550100" },
    occurredAt: date,
    to: ["+14155550123"],
    text: "Is it in stock?",
    media: [{ type: "image", contentType: "image/png", filename: null, caption: "photo" }],
    template: null,
    summary: null,
    contextMessageId: null,
  };
  const body = () => requests[0]?.body;

  it("adds a WhatsApp endpoint and prints its business account", async () => {
    const result = await run(
      ["endpoints", "add", mailboxId, "--channel", "whatsapp", "--address", "+14155550123"],
      whatsappMailbox,
      201,
    );
    expect(result.code, result.stderr).toBe(0);
    assertRequest("POST", `/v1/mailboxes/${mailboxId}/endpoints`);
    expect(body()).toEqual({ channel: "whatsapp", address: "+14155550123" });
    expect(result.stdout).toContain("whatsapp: +14155550123");
    expect(result.stdout).toContain("business account waba_1234567890123456");
    const line = result.stdout.split("\n").find((l) => l.includes("whatsapp:"));
    expect(line).not.toContain("domain");
  });
  it("creates a mailbox on an SMS number", async () => {
    const result = await run(
      ["create", "--channel", "sms", "--address", "+14155550123", "--name", "Alerts", "--json"],
      mailbox,
      201,
    );
    expect(result.code, result.stderr).toBe(0);
    assertRequest("POST", "/v1/mailboxes");
    expect(body()).toEqual({
      endpoint: { channel: "sms", address: "+14155550123" },
      name: "Alerts",
    });
  });
  it("sends a WhatsApp template with its data and the idempotency key", async () => {
    const result = await run(
      [
        "send",
        mailboxId,
        "--channel",
        "whatsapp",
        "--to",
        "+14155550100",
        "--template",
        templateId,
        "--data",
        '{"name":"Ada"}',
        "--idempotency-key",
        "wa-1",
      ],
      receipt("accepted"),
    );
    expect(result.code, result.stderr).toBe(0);
    assertRequest("POST", `/v1/mailboxes/${mailboxId}/messages`);
    expect(requests[0]?.headers["idempotency-key"]).toBe("wa-1");
    expect(body()).toEqual({
      channel: "whatsapp",
      to: "+14155550100",
      templateId,
      templateData: { name: "Ada" },
    });
    expect(result.stdout).toContain("Send accepted");
  });
  for (const [args, code] of [
    [
      ["--channel", "sms", "--to", "+14155550100", "--template", templateId],
      "mailbox_chat_template",
    ],
    [["--channel", "whatsapp", "--to", "+14155550100"], "mailbox_chat_content_required"],
    [
      ["--channel", "whatsapp", "--to", "+14155550100", "--text", "x", "--subject", "s"],
      "mailbox_chat_recipient",
    ],
    [["--channel", "sms", "--to", "+14155550100", "--html", "<b>x</b>"], "mailbox_chat_html"],
    [["--to", "a@example.com", "--text", "x"], "mailbox_subject_required"],
    [
      ["--to", "a@example.com", "--subject", "s", "--template", templateId],
      "mailbox_template_channel",
    ],
  ] as const) {
    it(`refuses a send before any request: ${code}`, async () => {
      const result = await run(["send", mailboxId, ...args], {});
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(code);
      expect(requests).toHaveLength(0);
    });
  }
  it("points a closed service window at a template", async () => {
    const result = await run(
      ["send", mailboxId, "--channel", "whatsapp", "--to", "+14155550100", "--text", "x", "--json"],
      {
        _tag: "WhatsAppServiceWindowClosedError",
        message: "The 24-hour service window closed. Send an approved template instead.",
        closedAt: date,
      },
      422,
    );
    expect(result.code).toBe(1);
    const error = JSON.parse(result.stderr);
    expect(error).toMatchObject({ reason: "WhatsAppServiceWindowClosedError", status: 422 });
    expect(error.next).toContain("--template");
  });
  it("names a disabled channel", async () => {
    const result = await run(
      ["send", mailboxId, "--channel", "sms", "--to", "+14155550100", "--text", "x", "--json"],
      { _tag: "FlagDisabledError", message: "Feature 'sms' is not enabled.", flag: "sms" },
      403,
    );
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stderr).next).toContain("SMS is not enabled");
  });
  it("replies on a WhatsApp thread with a chat payload", async () => {
    requests = [];
    peeks = 0;
    repliedMessage = chatMessage;
    responses = [{ status: 202, body: receipt("queued") }];
    const result = await runCli(
      ["--no-env-file", runner, "mailboxes", "reply", mailboxId, messageId, "--text", "Yes"],
      {
        executable: "bun",
        configHome: home,
        env: { SAMVA_API_URL: apiUrl, SAMVA_API_KEY: "sk_test_mailbox" },
      },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(peeks).toBe(1);
    assertRequest("POST", `/v1/mailboxes/${mailboxId}/messages/${messageId}/reply`);
    expect(body()).toEqual({ channel: "whatsapp", text: "Yes" });
  });
  it("replies with a template without reading the message first", async () => {
    const result = await run(
      ["reply", mailboxId, messageId, "--template", templateId, "--json"],
      receipt("queued"),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(peeks).toBe(0);
    assertRequest("POST", `/v1/mailboxes/${mailboxId}/messages/${messageId}/reply`);
    expect(body()).toEqual({ channel: "whatsapp", templateId });
  });
  it("prints a chat message's text, media, and thread channel", async () => {
    const result = await run(["read", mailboxId, messageId], chatMessage);
    expect(result.code, result.stderr).toBe(0);
    for (const fact of ["Is it in stock?", "image — image/png", 'caption "photo"', "+14155550123"])
      expect(result.stdout).toContain(fact);
    expect(result.stdout).not.toContain("Subject");
  });
  it("lists a WhatsApp thread with its channel", async () => {
    const result = await run(["threads", mailboxId], {
      items: [{ ...thread, channel: "whatsapp", subject: null }],
      nextCursor: null,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Channel");
    expect(result.stdout).toContain("whatsapp");
  });
});
