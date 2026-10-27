import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { WEBHOOK_EVENT_TYPE_VALUES } from "@samva/core/shared/enums";

import { rootCommands } from "../src/lib/root-commands";
import { commandNameFromArgv } from "../src/lib/runtime";
import {
  type CliOptions,
  type CliResult,
  runCli as runCliProcess,
  spawnCli,
} from "./support/run-cli";

// Process-level contract tests: they run the real CLI as a subprocess (under
// Bun, its runtime) and assert the agent-facing output contract — stream
// separation, --json stdout purity, --log-level none leaving data intact, and
// honest exit codes on failure. These lock the three-plane behavior end to end,
// including the command-tree and lifecycle-output contracts.

interface MachineResult<T> {
  readonly schemaVersion: 1;
  readonly type: "result";
  readonly command: string;
  readonly data: T;
  readonly partial?: true | undefined;
}

const parseResult = <T>(stdout: string): T => {
  const envelope = JSON.parse(stdout) as MachineResult<T>;
  expect(envelope).toMatchObject({ schemaVersion: 1, type: "result" });
  return envelope.data;
};

let configHome = "";

const runCli = (args: ReadonlyArray<string>, options: Omit<CliOptions, "configHome"> = {}) =>
  runCliProcess(args, { configHome, ...options });

const startPendingMessageApi = (
  options: {
    readonly deliverOnRead?: number | undefined;
    readonly heldSend?: boolean | undefined;
    readonly failMessageAfterRead?: number | undefined;
    readonly failSecondPage?: boolean | undefined;
    readonly emptyMessages?: boolean | undefined;
  } = {},
): Promise<{
  url: string;
  messageReads: () => number;
  listQueries: () => ReadonlyArray<string>;
  close: () => Promise<void>;
}> =>
  new Promise((resolve) => {
    const now = "2026-07-21T00:00:00.000Z";
    const message = {
      id: "msg_1234567890abcdefgh",
      channel: "email",
      direction: "outbound",
      status: options.heldSend ? "queued" : "sent",
      from: { address: "hello@example.com", name: null },
      to: [{ address: "a@b.com", contactId: null }],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: "Hi",
      conversationId: null,
      inReplyToMessageId: null,
      tags: [],
      metadata: {},
      isTest: false,
      scheduledAt: null,
      submission: null,
      waitReason: options.heldSend ? "content-review" : null,
      skippedRecipients: options.heldSend
        ? [{ address: "blocked@example.com", reason: "bounce" }]
        : [],
      reviewExpectedAt: options.heldSend ? "2026-07-21T00:10:00.000Z" : null,
      createdAt: now,
      updatedAt: now,
    };
    const receipt = {
      id: message.id,
      status: message.status,
      waitReason: message.waitReason,
      skippedRecipients: message.skippedRecipients,
      reviewExpectedAt: message.reviewExpectedAt,
      createdAt: now,
    };
    const delivery = {
      id: "mdel_1234567890abcdefgh",
      recipient: "a@b.com",
      status: "sent",
      attemptCount: 1,
      waitReason: null,
      skippedRecipients: [],
      nextRetryAt: null,
      sentAt: now,
      deliveredAt: null,
      readAt: null,
      failedAt: null,
      error: null,
      estimatedProviderCost: null,
      createdAt: now,
      updatedAt: now,
    };
    const summary = {
      id: message.id,
      channel: "email",
      direction: "outbound",
      status: "sent",
      from: "hello@example.com",
      to: ["a@b.com"],
      subject: "Hi",
      waitReason: null,
      skippedRecipients: [],
      createdAt: now,
    };
    let messageReads = 0;
    const listQueries: Array<string> = [];
    const server: Server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/messages") {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify(receipt));
        return;
      }
      if (
        req.method === "POST" &&
        req.url === "/v1/email/domains/dom_1234567890abcdefgh/enable-receiving"
      ) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            recipients: ["replies@example.com"],
          }),
        );
        return;
      }
      if (
        req.method === "GET" &&
        req.url === "/v1/email/domains/dom_1234567890abcdefgh/receiving-status"
      ) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            domain: "example.com",
            receivingHost: "example.com",
            sending: { satisfied: true, phase: "ready" },
            destination: { satisfied: true, endpointId: null, forwardingRules: 2, mailboxes: 1 },
            receiving: { satisfied: true, catchAll: true },
            mx: {
              satisfied: false,
              state: "elsewhere",
              expected: { exchange: "inbound-smtp.us-east-1.amazonaws.com", priority: 10 },
              current: [{ exchange: "route1.mx.cloudflare.net", priority: 5 }],
            },
            ready: false,
          }),
        );
        return;
      }
      if (
        req.method === "GET" &&
        (req.url === "/v1/messages" || req.url?.startsWith("/v1/messages?"))
      ) {
        const listUrl = new URL(req.url, "http://localhost");
        listQueries.push(listUrl.search);
        const secondPage = listUrl.searchParams.get("cursor") === "cursor_page_2";
        if (secondPage && options.failSecondPage) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ _tag: "InternalError", message: "second page failed" }));
          return;
        }
        if (options.emptyMessages) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ items: [], nextCursor: null }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            secondPage
              ? { items: [{ ...summary, id: "msg_2234567890abcdefgh" }], nextCursor: null }
              : { items: [summary], nextCursor: "cursor_page_2" },
          ),
        );
        return;
      }
      const delivered = () =>
        options.deliverOnRead !== undefined && messageReads >= options.deliverOnRead;
      if (req.method === "GET" && req.url === `/v1/messages/${message.id}/deliveries`) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            items: [
              delivered() ? { ...delivery, status: "delivered", deliveredAt: now } : delivery,
            ],
          }),
        );
        return;
      }
      if (req.method === "GET" && req.url === `/v1/messages/${message.id}`) {
        messageReads += 1;
        if (
          options.failMessageAfterRead !== undefined &&
          messageReads >= options.failMessageAfterRead
        ) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ _tag: "UnauthorizedError", message: "credential revoked" }));
          return;
        }
        const response = delivered() ? { ...message, status: "delivered" } : message;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ _tag: "ResourceNotFoundError", message: "not found" }));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        messageReads: () => messageReads,
        listQueries: () => listQueries,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });

const startDoctorApi = (): Promise<{
  url: string;
  requests: ApiRequest[];
  close: () => Promise<void>;
}> =>
  new Promise((resolve) => {
    const requests: ApiRequest[] = [];
    const server: Server = createServer((req, res) => {
      const path = req.url ?? "/";
      requests.push({ method: req.method ?? "GET", path, body: null });
      if (path === "/v1/health/ping") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("pong");
        return;
      }
      const emptyPage = { items: [], nextCursor: null };
      const body = path.startsWith("/v1/organizations/current")
        ? {
            id: "org_1234567890abcdefgh",
            billingAccountId: "ba_1234567890abcdefgh",
            name: "Acme",
            slug: "acme",
            avatarUrl: null,
            defaultRegion: "US",
            timezone: "America/New_York",
            plan: "free",
            isActive: true,
            createdAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-01T00:00:00.000Z",
            metadata: null,
            replyToDefault: null,
            emailFooterEnabledDefault: null,
            messagesUsed: 0,
            messagesUsedThisMonth: 0,
            smsUsed: 0,
            smsUsedThisMonth: 0,
            whatsappUsed: 0,
            whatsappUsedThisMonth: 0,
            emailUsed: 0,
            emailUsedThisMonth: 0,
            contactsUsed: 0,
            conversationsUsed: 0,
            teamMembersUsed: 0,
            messagesResetAt: null,
          }
        : path.startsWith("/v1/email/onboarding-review")
          ? {
              decision: "approved",
              trustTier: "established",
              stage: "complete",
              generation: 1,
              canSend: true,
              code: null,
              nextAction: null,
              canReapply: false,
              informationRequest: null,
              identities: [],
              updatedAt: "2026-07-01T00:00:00.000Z",
            }
          : emptyPage;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });

const startPendingOAuth = (): Promise<{ url: string; close: () => Promise<void> }> =>
  new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      res.writeHead(req.url?.endsWith("/device/code") ? 200 : 400, {
        "content-type": "application/json",
      });
      res.end(
        JSON.stringify(
          req.url?.endsWith("/device/code")
            ? {
                device_code: "device-test",
                user_code: "TEST-CODE",
                verification_uri: "https://example.test/device",
                expires_in: 300,
                interval: 30,
              }
            : { error: "authorization_pending" },
        ),
      );
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });

interface ApiRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

const startApi = (): Promise<{
  url: string;
  requests: ApiRequest[];
  close: () => Promise<void>;
}> =>
  new Promise((resolve) => {
    const requests: ApiRequest[] = [];
    // Every list row now carries a 14-day send series; an entity that has never
    // sent reports fourteen zeroes.
    const zeroSeries = Array.from({ length: 14 }, () => 0);
    let trackingDefaults = { opens: true, clicks: true };
    let recipientTracking = {
      email: "reader@example.com",
      optedOut: false,
      trackingOptedOutAt: null as string | null,
      createdAt: null as string | null,
      updatedAt: null as string | null,
    };
    const scheduled = {
      id: "sched_1234567890abcdefgh",
      status: "pending",
      scheduledFor: "2026-08-01T09:00:00.000Z",
      timezone: "America/New_York",
      send: {
        channel: "email",
        to: [{ email: "ada@example.com" }],
        email: { templateSlug: "welcome-email", templateData: { name: "Ada" } },
      },
      messageId: null,
      idempotencyKey: "welcome-ada",
      referenceId: null,
      failureReason: null,
      attempts: 0,
      createdBy: "user_test",
      actorEmail: "owner@example.com",
      memberRole: "owner",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    };
    const campaign = {
      id: "camp_1234567890abcdefgh",
      name: "Launch",
      channel: "email",
      content: { channel: "email", email: { templateSlug: "launch" } },
      audience: { topicId: "unsub_1234567890abcdef", includeTags: ["newsletter"] },
      policy: {},
      definition: { state: "editable", frozenAt: null },
      latestRun: null,
      createdBy: "user_test",
      status: "draft",
      actorEmail: "owner@example.com",
      memberRole: "owner",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      series: zeroSeries,
    };
    const run = {
      id: "crun_1234567890abcdefgh",
      campaignId: campaign.id,
      status: "scheduled",
      scheduledFor: "2026-08-01T09:00:00.000Z",
      idempotencyKey: "launch-august",
      startedAt: null,
      completedAt: null,
      contentSnapshot: campaign.content,
      audienceSnapshot: campaign.audience,
      policySnapshot: {},
      totalRecipients: 1,
      dispatchedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      pendingCount: 1,
      skippedReasons: [],
      estimatedCompletionAt: null,
      failureReason: null,
      holdReason: null,
      holdDomainId: null,
      holdUntil: null,
      capacityWarning: null,
      lastContactId: null,
      createdBy: "user_test",
      actorEmail: "owner@example.com",
      memberRole: "owner",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    };
    const domain = {
      id: "dom_1234567890abcdefgh",
      namespaceId: null,
      domain: "example.com",
      phase: "ready",
      isDefault: false,
      deliverability: { bounceRate: 0, complaintRate: 0, windowSends: 0, sendingStatus: "unknown" },
      series: zeroSeries,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    };
    const sender = {
      id: "sender_1234567890abcdef",
      namespaceId: null,
      organizationId: "org_1234567890abcdefgh",
      email: "hello@example.com",
      name: "Example",
      domainId: domain.id,
      verificationStatus: "verified",
      verifiedAt: "2026-07-01T00:00:00.000Z",
      verificationToken: null,
      providerLifecycle: "active",
      providerFailureCode: null,
      isDefault: true,
      replyToEmails: null,
      deliverability: { bounceRate: 0, complaintRate: 0, windowSends: 0, sendingStatus: "unknown" },
      series: zeroSeries,
      isActive: true,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    };
    const template = {
      id: "tmpl_1234567890abcdef",
      namespaceId: null,
      shared: false,
      projectId: "tproj_1234567890abcdef",
      entryPath: "templates/welcome.tsx",
      name: "Welcome",
      slug: "welcome",
      familyId: null,
      channel: "email",
      description: null,
      category: null,
      email: { subject: "Welcome", preheader: null, headers: null },
      sms: null,
      whatsapp: null,
      publicationId: null,
      brand: null,
      inputContractId: null,
      inputSchema: null,
      usageCount: 0,
      lastUsedAt: null,
      status: "draft",
      isActive: true,
      publishedAt: null,
      fromDefault: null,
      replyToDefault: null,
      trackingDefault: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    };
    const webhook = {
      id: "wep_1234567890abcdef",
      name: "Delivery",
      url: "https://example.com/hook",
      eventTypes: ["message.delivered"],
      channels: ["email"],
      mailboxIds: null,
      namespaceId: null,
      status: "active",
      hasCustomHeaders: false,
      failureStartedAt: null,
      lastSucceededAt: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    };
    const server: Server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += String(chunk)));
      req.on("end", () => {
        const path = req.url ?? "/";
        requests.push({ method: req.method ?? "GET", path, body: raw ? JSON.parse(raw) : null });
        let result: unknown;
        if (path === "/v1/whoami") {
          result = {
            organization: { id: "org_3m8p2vqz6ty4bnkd", slug: "key-org", name: "Key Org" },
            credential: {
              type: "apiKey",
              id: "key_1234567890abcdef",
              name: "ci",
              start: "samva_sk_",
              access: { mode: "full" },
            },
          };
        } else if (path === "/v1/subscriptions") {
          result = { success: true, expiresAt: "2026-09-08T00:00:00.000Z" };
        } else if (path === "/v1/email/tracking/defaults") {
          if (req.method === "PATCH") {
            trackingDefaults = { ...trackingDefaults, ...(JSON.parse(raw) as object) };
          }
          result = trackingDefaults;
        } else if (path.startsWith("/v1/email/tracking/recipients")) {
          if (req.method === "PATCH") {
            const body = JSON.parse(raw) as { email: string; optedOut: boolean };
            recipientTracking = {
              ...recipientTracking,
              email: body.email.trim().toLowerCase(),
              optedOut: body.optedOut,
              trackingOptedOutAt: body.optedOut ? "2026-07-21T12:00:00.000Z" : null,
              createdAt: recipientTracking.createdAt ?? "2026-07-21T12:00:00.000Z",
              updatedAt: "2026-07-21T12:00:00.000Z",
            };
          }
          result = recipientTracking;
        } else if (path.startsWith("/v1/messages/scheduled")) {
          if (req.method === "GET" && /^\/v1\/messages\/scheduled(?:\?|$)/.test(path)) {
            result = {
              items: [scheduled],
              nextCursor: null,
            };
          } else if (path.endsWith("/cancel")) {
            result = { success: true, item: { ...scheduled, status: "cancelled" } };
          } else result = scheduled;
        } else if (path.includes("/recipients")) {
          result = {
            items: [
              {
                id: "crcpt_1234567890abcdef",
                runId: run.id,
                contactId: "contact_1234567890abcdef",
                status: "pending",
                messageId: null,
                failureReason: null,
                skippedReason: null,
                createdAt: run.createdAt,
                updatedAt: run.updatedAt,
              },
            ],
            nextCursor: null,
          };
        } else if (path.includes("/runs")) {
          if (req.method === "GET" && /\/runs(?:\?|$)/.test(path)) {
            result = { items: [run], nextCursor: null };
          } else if (/\/(pause|resume|cancel)$/.test(path)) result = { success: true, item: run };
          else result = run;
        } else if (req.method === "GET" && /^\/v1\/campaigns(?:\?|$)/.test(path)) {
          result = {
            items: [campaign],
            nextCursor: null,
          };
        } else if (req.method === "GET" && path.startsWith("/v1/email/domains")) {
          result = {
            items: [domain],
            nextCursor: null,
          };
        } else if (req.method === "GET" && path.startsWith("/v1/email/senders")) {
          result = {
            items: [sender],
            nextCursor: null,
          };
        } else if (req.method === "GET" && path.startsWith("/v1/templates")) {
          result = {
            items: [template],
            nextCursor: null,
          };
        } else if (req.method === "PATCH" && path.startsWith("/v1/templates/")) {
          result = { ...template, shared: true };
        } else if (req.method === "GET" && path.startsWith("/v1/webhooks")) {
          result = {
            // The list row carries its endpoint's delivery counts, so a row is one request.
            items: [
              {
                ...webhook,
                deliveries: { total: 0, pending: 0, delivered: 0, exhausted: 0, cancelled: 0 },
              },
            ],
            nextCursor: null,
          };
        } else if (req.method === "POST" && /^\/v1\/webhooks\/[^/]+\/test$/.test(path)) {
          result = {
            accepted: true,
            eventId: "whevt_1234567890abcdef",
            deliveryId: "whdel_1234567890abcdef",
          };
        } else if (path.endsWith("/rotate-secret")) {
          result = { secret: "whsec_display_once" };
        } else if (req.method === "POST" && path === "/v1/webhooks") {
          result = { endpoint: webhook, secret: "whsec_created_once" };
        } else if (req.method === "DELETE" && path.startsWith("/v1/email/domains/")) {
          result = { success: true, message: "Domain removed" };
        } else result = campaign;
        const isCreate =
          req.method === "POST" &&
          (path === "/v1/messages/scheduled" ||
            path === "/v1/webhooks" ||
            path === "/v1/campaigns" ||
            /\/v1\/campaigns\/[^/]+\/runs$/.test(path));
        const status = /^\/v1\/webhooks\/[^/]+\/test$/.test(path) ? 202 : isCreate ? 201 : 200;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });

const DEV_URL = "http://127.0.0.1:59999"; // dev-looking, unreachable — fine for dry-runs

beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), "samva-cli-e2e-"));
});

afterEach(async () => {
  if (configHome) await rm(configHome, { recursive: true, force: true });
});

describe("--json stdout purity", () => {
  it("maps parser failures to usage exit 2 with an empty stdout data plane", async () => {
    const { code, stdout, stderr } = await runCli(["email", "send", "--unknown"]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("Unrecognized flag");
  });

  it("maps handler validation failures to typed JSON diagnostics on stderr", async () => {
    const { code, stdout, stderr } = await runCli([
      "email",
      "send",
      "--to",
      "ada@example.com",
      "--text",
      "Hello",
      "--json",
    ]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({
      schemaVersion: 1,
      type: "error",
      reason: "missing_subject",
    });
  });

  it("refuses two publication references on one send, before any API call", async () => {
    const { code, stdout, stderr } = await runCli([
      "email",
      "send",
      "--to",
      "ada@example.com",
      "--template-id",
      "tmpl_2eqcmea000000000",
      "--publication-id",
      "tpub_2eqcmea000000000",
      "--input-contract-id",
      "tcon_2eqcmea000000000",
      "--json",
    ]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({
      type: "error",
      message: expect.stringContaining("not both"),
    });
  });

  it("refuses a publication reference with no template to reference", async () => {
    const { code, stderr } = await runCli([
      "email",
      "send",
      "--to",
      "ada@example.com",
      "--template-slug",
      "welcome",
      "--publication-id",
      "tpub_2eqcmea000000000",
      "--json",
    ]);
    expect(code).toBe(1);
    expect(JSON.parse(stderr)).toMatchObject({
      type: "error",
      message: expect.stringContaining("need --template-id"),
    });
  });

  it("rejects mutually exclusive global output modes before command parsing", async () => {
    const { code, stdout, stderr } = await runCli(["help", "--json", "--quiet"]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({
      schemaVersion: 1,
      reason: "mutually_exclusive_output_mode",
    });
  });

  it("rejects assignment-spelled output modes without letting them bypass machine diagnostics", async () => {
    for (const args of [
      ["help", "--json=true"],
      ["help", "--json=false"],
      ["help", "--json=true", "--quiet"],
    ]) {
      const { code, stdout, stderr } = await runCli(args);
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(JSON.parse(stderr)).toMatchObject({
        schemaVersion: 1,
        type: "error",
        command: "help",
        reason: "invalid_output_mode_syntax",
      });
    }
  });

  it("honors -- as an output-mode terminator", async () => {
    const { code, stdout, stderr } = await runCli(["help", "--", "--json"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Run `samva <command> --help`");
    expect(stderr).toBe("");
  });

  it("publishes a machine-readable help manifest without status noise", async () => {
    const { code, stdout, stderr } = await runCli(["help", "--json"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const manifest = parseResult<{
      schemaVersion: number;
      name: string;
      commands: Array<string>;
      globalOptions: Array<string>;
    }>(stdout);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      name: "samva",
      globalOptions: expect.arrayContaining(["--json", "--jsonl", "--quiet", "--completions"]),
    });
    expect(manifest.commands).toEqual([
      "login",
      "logout",
      "org",
      "email",
      "messages",
      "contacts",
      "events",
      "journeys",
      "campaigns",
      "subscriptions",
      "topics",
      "scheduled-messages",
      "templates",
      "brands",
      "mailboxes",
      "namespaces",
      "extensions",
      "webhooks",
      "api",
      "api-keys",
      "profile",
      "feedback",
      "help",
    ]);
  });

  it("describes the root command for -h and rejects an unknown command before --help", async () => {
    const shortHelp = await runCli(["--json", "-h"]);
    expect(shortHelp.code).toBe(0);
    expect(parseResult(shortHelp.stdout)).toMatchObject({
      usage: "samva <subcommand> [flags]",
    });

    const invalid = await runCli(["--help", "bogus", "--json"]);
    expect(invalid.code).not.toBe(0);
    expect(invalid.stdout).toBe("");
    expect(JSON.parse(invalid.stderr)).toMatchObject({
      schemaVersion: 1,
      type: "error",
      command: "samva",
    });
  });

  it("generates discoverable shell completion scripts", async () => {
    for (const shell of ["bash", "zsh", "fish", "sh"] as const) {
      const result = await runCli(["--completions", shell]);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("samva");
      expect(result.stdout).toContain("###-begin-samva-completions-###");
    }
  });

  it("honors root-level machine and quiet global flags", async () => {
    const json = await runCli(["--json", "help"]);
    expect(json.code).toBe(0);
    expect(parseResult(json.stdout)).toMatchObject({ name: "samva" });
    expect(json.stderr).toBe("");

    const quiet = await runCli(["--quiet", "help"]);
    expect(quiet.code).toBe(0);
    expect(quiet.stdout).toBe("");
    expect(quiet.stderr).toBe("");

    const jsonl = await runCli(["--jsonl", "help"]);
    expect(jsonl.code).toBe(0);
    expect(jsonl.stderr).toBe("");
    expect(JSON.parse(jsonl.stdout)).toMatchObject({
      schemaVersion: 1,
      type: "result",
      command: "help",
      data: { name: "samva" },
    });
  });

  it("keeps profile mutations machine-clean and quiet suppresses their human result", async () => {
    const created = await runCli(["--json", "profile", "create", "matrix-profile"]);
    expect(created.code).toBe(0);
    expect(created.stderr).toBe("");
    expect(parseResult(created.stdout)).toMatchObject({
      action: "profile.create",
      name: "matrix-profile",
    });

    const used = await runCli(["--jsonl", "profile", "use", "matrix-profile"]);
    expect(used.code).toBe(0);
    expect(used.stderr).toBe("");
    expect(parseResult(used.stdout)).toMatchObject({
      action: "profile.use",
      name: "matrix-profile",
    });

    const quiet = await runCli(["--quiet", "profile", "use", "matrix-profile"]);
    expect(quiet.code).toBe(0);
    expect(quiet.stdout).toBe("");
    expect(quiet.stderr).toBe("");
  });

  it("rejects API-key organization overrides as an auth/context error", async () => {
    const result = await runCli(["--json", "org", "use", "other-org"], {
      env: { SAMVA_API_KEY: "samva_sk_test" },
    });
    expect(result.code).toBe(4);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ reason: "api_key_org_override" });
  });

  it("resolves an isolated named profile without storing plaintext credentials", async () => {
    const created = await runCli(["profile", "create", "named-e2e"]);
    expect(created.code).toBe(0);
    const listed = await runCli(["--json", "profile", "list"]);
    expect(listed.code).toBe(0);
    expect(parseResult(listed.stdout)).toMatchObject({
      profiles: { "named-e2e": { credentialIdentity: "none" } },
    });
    expect(listed.stderr).toBe("");
  });

  it("refuses a profile target flag", async () => {
    const created = await runCli(["profile", "create", "targeted", "--target", "production"]);
    expect(created.code).toBe(2);
  });

  it.each(["local", "production"])(
    "refuses a stored %s profile target and names the API URL overrides",
    async (target) => {
      const isolated = await mkdtemp(join(tmpdir(), "samva-cli-profile-target-"));
      try {
        await mkdir(join(isolated, "samva"), { recursive: true });
        await writeFile(
          join(isolated, "samva", "config.json"),
          JSON.stringify({
            version: 2,
            profiles: { dev: { target, credentialIdentity: "none" } },
          }),
        );
        const shown = await runCli(["--json", "profile", "show"], {
          env: { XDG_CONFIG_HOME: isolated, SAMVA_API_KEY: "samva_sk_test" },
        });
        expect(shown.code).toBe(2);
        expect(shown.stdout).toBe("");
        const error = JSON.parse(shown.stderr) as { reason: string; message: string };
        expect(error.reason).toBe("unsupported_profile_target");
        expect(error.message).toContain("Profile dev");
        expect(error.message).toContain("--api-url");
        expect(error.message).toContain("SAMVA_API_URL");
      } finally {
        await rm(isolated, { recursive: true, force: true });
      }
    },
  );

  it("fails non-interactive login before opening a browser or requesting credentials", async () => {
    const result = await runCli(["login", "--no-input", "--json"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ reason: "interactive_login_disabled" });
  });

  it("treats machine login as non-interactive without requiring --no-input", async () => {
    const result = await runCli(["login", "--json"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ reason: "interactive_login_disabled" });
  });

  it("fails bare non-TTY login before requesting a device code", async () => {
    const result = await runCli(["login"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("SAMVA_API_KEY");
    expect(result.stderr).toContain("--no-browser");
  });

  it("writes a schema-valid default profile when selecting an OAuth organization", async () => {
    const isolated = await mkdtemp(join(tmpdir(), "samva-cli-org-use-"));
    try {
      const selected = await runCli(["org", "use", "fresh-org"], {
        env: { XDG_CONFIG_HOME: isolated },
      });
      expect(selected.code).toBe(0);

      const current = await runCli(["org", "current", "--json"], {
        env: { XDG_CONFIG_HOME: isolated },
      });
      expect(current.code).toBe(0);
      expect(parseResult(current.stdout)).toEqual({ activeOrgSlug: "fresh-org" });
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  });

  it("keeps a stored OAuth org out of an API-key execution context", async () => {
    const created = await runCli(["profile", "create", "key-custom", "--org", "oauth-org"]);
    expect(created.code).toBe(0);

    const shown = await runCli(["--profile", "key-custom", "--json", "profile", "show"], {
      env: { SAMVA_API_KEY: "samva_sk_test", SAMVA_API_URL: "https://api.samva.localhost" },
    });
    expect(shown.code).toBe(0);
    expect(parseResult(shown.stdout)).toMatchObject({
      name: "key-custom",
      apiUrl: "https://api.samva.localhost",
    });

    const api = await startApi();
    try {
      const current = await runCli(["--profile", "key-custom", "org", "current", "--json"], {
        env: { SAMVA_API_KEY: "samva_sk_test", SAMVA_API_URL: api.url },
      });
      expect(current.code, current.stderr).toBe(0);
      expect(parseResult(current.stdout)).toEqual({
        activeOrgSlug: "key-org",
        organization: { id: "org_3m8p2vqz6ty4bnkd", slug: "key-org", name: "Key Org" },
        credential: { type: "apiKey", id: "key_1234567890abcdef", name: "ci" },
      });
      const human = await runCli(["--profile", "key-custom", "org", "current"], {
        env: { SAMVA_API_KEY: "samva_sk_test", SAMVA_API_URL: api.url },
      });
      expect(human.stdout.trim()).toBe("key-org");
      expect(api.requests.map((request) => request.path)).toEqual(["/v1/whoami", "/v1/whoami"]);
    } finally {
      await api.close();
    }
  });

  it("explains an org current failure under an API key the API refuses", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ _tag: "UnauthorizedError", message: "Invalid API key" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const result = await runCli(["org", "current"], {
        env: { SAMVA_API_KEY: "samva_sk_test", SAMVA_API_URL: `http://127.0.0.1:${port}` },
      });
      expect(result.code).toBe(4);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Could not look up the organization for SAMVA_API_KEY");
      expect(result.stderr).toContain("Invalid API key");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("org current --json keeps failed result data off stdout", async () => {
    const { code, stdout, stderr } = await runCli(["org", "current", "--json"]);
    expect(code).not.toBe(0); // no active org in an isolated config
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({ type: "error", reason: "missing_organization" });
  });

  it("email send dry-run --json includes the bounded idempotency key in a pure payload", async () => {
    const { code, stdout, stderr } = await runCli(
      [
        "email",
        "send",
        "--to",
        "a@b.com",
        "--subject",
        "Hi",
        "--text",
        "Hello",
        "--idempotency-key",
        "welcome-email-ada",
        "--track-opens",
        "off",
        "--track-clicks",
        "on",
        "--dry-run",
        "--json",
      ],
      { env: { SAMVA_API_KEY: "samva_sk_test_x" } },
    );
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const parsed = parseResult<{
      dryRun: boolean;
      request: {
        subject: string;
        idempotencyKey?: string | undefined;
        tracking: { opens: boolean; clicks: boolean };
      };
      idempotencyKey: string;
    }>(stdout);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.request.subject).toBe("Hi");
    // The key travels as the Idempotency-Key header now, not in the body.
    expect(parsed.request.idempotencyKey).toBeUndefined();
    expect(parsed.idempotencyKey).toBe("welcome-email-ada");
    expect(parsed.request.tracking).toEqual({ opens: false, clicks: true });
  });

  it("email send carries --locale and --time-zone on a template send only", async () => {
    const sent = await runCli(
      [
        "email",
        "send",
        "--to",
        "a@b.com",
        "--template-slug",
        "order-receipt",
        "--locale",
        "de-DE",
        "--time-zone",
        "Europe/Berlin",
        "--dry-run",
        "--json",
      ],
      { env: { SAMVA_API_KEY: "samva_sk_test_x" } },
    );
    expect(sent.code).toBe(0);
    expect(parseResult(sent.stdout)).toMatchObject({
      request: { templateSlug: "order-receipt", locale: "de-DE", timeZone: "Europe/Berlin" },
    });

    const inline = await runCli(
      [
        "email",
        "send",
        "--to",
        "a@b.com",
        "--subject",
        "Hi",
        "--text",
        "Hello",
        "--locale",
        "de-DE",
        "--dry-run",
        "--json",
      ],
      { env: { SAMVA_API_KEY: "samva_sk_test_x" } },
    );
    expect(inline.code).not.toBe(0);
    expect(inline.stderr).toContain("--locale and --time-zone apply to template sends");
  });

  it("reads stdin only when --text - explicitly requests it", async () => {
    const ordinary = await runCli(
      [
        "email",
        "send",
        "--to",
        "a@b.com",
        "--subject",
        "Hi",
        "--text",
        "Body",
        "--dry-run",
        "--json",
      ],
      { stdin: "ignored stdin" },
    );
    expect(ordinary.code).toBe(0);
    expect(parseResult(ordinary.stdout)).toMatchObject({ request: { text: "Body" } });

    const piped = await runCli(
      ["email", "send", "--to", "a@b.com", "--subject", "Hi", "--text", "-", "--dry-run", "--json"],
      { stdin: "piped body" },
    );
    expect(piped.code).toBe(0);
    expect(parseResult(piped.stdout)).toMatchObject({ request: { text: "piped body" } });
  });

  it("email send rejects idempotency keys outside the 1-255 character contract", async () => {
    for (const idempotencyKey of ["", "x".repeat(256)]) {
      const result = await runCli(
        [
          "email",
          "send",
          "--to",
          "a@b.com",
          "--subject",
          "Hi",
          "--text",
          "Hello",
          "--idempotency-key",
          idempotencyKey,
          "--dry-run",
          "--json",
        ],
        { env: { SAMVA_API_KEY: "samva_sk_test_x" } },
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("1 and 255 characters");
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({ type: "error" });
    }
  });

  it("email send help documents retry-safe sends", async () => {
    const result = await runCli(["email", "send", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--idempotency-key");
    expect(result.stdout).toContain("welcome-email-ada");
    expect(result.stdout).toContain("--track-opens");
    expect(result.stdout).toContain("--track-clicks");
    expect(result.stderr).toBe("");
  });

  it("email tracking mutations keep dry-run offline", async () => {
    const preview = await runCli([
      "email",
      "tracking",
      "defaults",
      "set",
      "--opens",
      "off",
      "--dry-run",
      "--json",
    ]);
    expect(preview).toMatchObject({ code: 0, stderr: "" });
    expect(parseResult(preview.stdout)).toEqual({
      dryRun: true,
      action: "email.tracking.defaults.set",
      request: { opens: false },
    });

    const recipientPreview = await runCli([
      "email",
      "tracking",
      "recipient",
      "set",
      "Reader@Example.com",
      "--state",
      "opted-out",
      "--dry-run",
      "--json",
    ]);
    expect(recipientPreview).toMatchObject({ code: 0, stderr: "" });
    expect(parseResult(recipientPreview.stdout)).toMatchObject({
      action: "email.tracking.recipient.set",
      request: { email: "Reader@Example.com", optedOut: true },
    });
  });

  it("email tracking recipient validation is identical for preview and apply", async () => {
    for (const suffix of [[], ["--dry-run"]] as const) {
      const result = await runCli([
        "email",
        "tracking",
        "recipient",
        "set",
        "not-an-email",
        "--state",
        "opted-out",
        ...suffix,
        "--json",
      ]);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({
        type: "error",
        reason: "invalid_recipient_email",
      });
    }
  });

  it("email tracking mutations return JSON readback", async () => {
    const api = await startApi();
    const env = { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url };
    try {
      const updated = await runCli(
        ["email", "tracking", "defaults", "set", "--clicks", "off", "--json"],
        { env },
      );
      expect(updated).toMatchObject({ code: 0, stderr: "" });
      expect(parseResult(updated.stdout)).toEqual({ opens: true, clicks: false });

      const recipient = await runCli(
        [
          "email",
          "tracking",
          "recipient",
          "set",
          "Reader@Example.com",
          "--state",
          "opted-out",
          "--json",
        ],
        { env },
      );
      expect(recipient).toMatchObject({ code: 0, stderr: "" });
      expect(parseResult(recipient.stdout)).toMatchObject({
        email: "reader@example.com",
        optedOut: true,
      });

      const readback = await runCli(
        ["email", "tracking", "recipient", "get", "reader@example.com", "--json"],
        { env },
      );
      expect(readback).toMatchObject({ code: 0, stderr: "" });
      expect(parseResult(readback.stdout)).toMatchObject({ optedOut: true });
      expect(api.requests.map(({ method, path }) => ({ method, path }))).toEqual([
        { method: "PATCH", path: "/v1/email/tracking/defaults" },
        { method: "PATCH", path: "/v1/email/tracking/recipients" },
        {
          method: "GET",
          path: "/v1/email/tracking/recipients?email=reader%40example.com",
        },
      ]);
    } finally {
      await api.close();
    }
  });

  it("scheduled create accepts a published template without --subject", async () => {
    const { code, stdout, stderr } = await runCli(
      [
        "scheduled-messages",
        "create",
        "--to",
        "ada@example.com",
        "--template-slug",
        "welcome-email",
        "--template-data",
        '{"name":"Ada"}',
        "--at",
        "2026-08-01T09:00:00Z",
        "--timezone",
        "America/New_York",
        "--idempotency-key",
        "welcome-ada",
        "--dry-run",
        "--json",
      ],
      { env: { SAMVA_API_KEY: "samva_sk_test_x" } },
    );
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const parsed = parseResult<{
      request: {
        send: { channel: string; email: Record<string, unknown> };
        scheduledFor: string;
        timezone: string;
      };
    }>(stdout);
    expect(parsed.request.send.channel).toBe("email");
    expect(parsed.request.send.email).not.toHaveProperty("subject");
    expect(parsed.request.scheduledFor).toBe("2026-08-01T09:00:00.000Z");
    expect(parsed.request.timezone).toBe("America/New_York");
  });

  it("scheduled create rejects inline HTML without --subject", async () => {
    const result = await runCli(
      [
        "scheduled-messages",
        "create",
        "--to",
        "ada@example.com",
        "--html",
        "<p>Hello</p>",
        "--at",
        "2026-08-01T09:00:00Z",
        "--dry-run",
        "--json",
      ],
      { env: { SAMVA_API_KEY: "samva_sk_test_x" } },
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--subject");
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "error" });
  });

  it("accepts valid absolute instants and rejects local or invalid calendar dates", async () => {
    for (const at of [
      "2026-08-01T09:00:00Z",
      "2026-08-01T09:00:00+05:30",
      "2024-02-29T09:00:00Z",
    ]) {
      const result = await runCli(
        [
          "scheduled-messages",
          "create",
          "--to",
          "ada@example.com",
          "--template-slug",
          "welcome-email",
          "--topic-id",
          "unsub_1234567890abcdef",
          "--at",
          at,
          "--dry-run",
          "--json",
        ],
        { env: { SAMVA_API_KEY: "samva_sk_test_x" } },
      );
      expect(result.code).toBe(0);
    }
    const api = await startApi();
    try {
      const result = await runCli(
        [
          "campaigns",
          "runs",
          "create",
          "camp_1234567890abcdefgh",
          "--at",
          "2024-02-29T09:00:00Z",
          "--json",
        ],
        { env: { SAMVA_API_URL: api.url, SAMVA_API_KEY: "samva_sk_test_x" } },
      );
      expect(result.code).toBe(0);
    } finally {
      await api.close();
    }
    for (const at of [
      "2026-08-01",
      "2026-08-01T09:00:00",
      "2026-02-29T09:00:00Z",
      "2026-02-30T09:00:00Z",
    ]) {
      for (const command of [
        [
          "scheduled-messages",
          "create",
          "--to",
          "ada@example.com",
          "--template-slug",
          "welcome-email",
          "--at",
          at,
          "--dry-run",
          "--json",
        ],
        ["campaigns", "runs", "create", "camp_1234567890abcdefgh", "--at", at, "--json"],
      ]) {
        const result = await runCli(command, { env: { SAMVA_API_KEY: "samva_sk_test_x" } });
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain("absolute ISO 8601 instant");
      }
    }
  });
});

describe("scheduled and campaign subprocess contracts", () => {
  it("executes scheduled create/list/get/cancel with JSON-only output", async () => {
    const api = await startApi();
    const env = { SAMVA_API_URL: api.url, SAMVA_API_KEY: "samva_sk_test_x" };
    try {
      const commands = [
        [
          "scheduled-messages",
          "create",
          "--to",
          "ada@example.com",
          "--template-slug",
          "welcome-email",
          "--topic-id",
          "unsub_1234567890abcdef",
          "--at",
          "2026-08-01T09:00:00Z",
          "--idempotency-key",
          "welcome-ada",
          "--track-opens",
          "off",
          "--json",
        ],
        ["scheduled-messages", "list", "--json"],
        ["scheduled-messages", "get", "sched_1234567890abcdefgh", "--json"],
        ["scheduled-messages", "cancel", "sched_1234567890abcdefgh", "--yes", "--json"],
      ] as const;
      for (const command of commands) {
        const result = await runCli(command, { env });
        expect(result.code, `${command.join(" ")}\n${result.stderr}`).toBe(0);
        expect(result.stderr).toBe("");
        expect(() => JSON.parse(result.stdout)).not.toThrow();
      }
      expect(api.requests).toEqual([
        {
          method: "POST",
          path: "/v1/messages/scheduled",
          body: {
            send: {
              channel: "email",
              to: [{ email: "ada@example.com" }],
              email: {
                templateSlug: "welcome-email",
                topicId: "unsub_1234567890abcdef",
                tracking: { opens: false },
              },
            },
            // The SDK now encodes `scheduledFor` through the contract schema,
            // which canonicalizes instants to millisecond-precision ISO.
            scheduledFor: "2026-08-01T09:00:00.000Z",
            idempotencyKey: "welcome-ada",
          },
        },
        { method: "GET", path: "/v1/messages/scheduled", body: null },
        { method: "GET", path: "/v1/messages/scheduled/sched_1234567890abcdefgh", body: null },
        {
          method: "POST",
          path: "/v1/messages/scheduled/sched_1234567890abcdefgh/cancel",
          body: null,
        },
      ]);
    } finally {
      await api.close();
    }
  });

  it("executes campaign create/update/schedule/list/get/control/recipients", async () => {
    const api = await startApi();
    const env = { SAMVA_API_URL: api.url, SAMVA_API_KEY: "samva_sk_test_x" };
    try {
      const commands = [
        [
          "campaigns",
          "create",
          "--name",
          "Launch",
          "--template-slug",
          "launch",
          "--topic-id",
          "unsub_1234567890abcdef",
          "--include-tags",
          "newsletter",
          "--track-clicks",
          "off",
          "--json",
        ],
        [
          "campaigns",
          "update",
          "camp_1234567890abcdefgh",
          "--name",
          "Launch v2",
          "--template-slug",
          "launch-v2",
          "--track-opens",
          "off",
          "--json",
        ],
        ["campaigns", "list", "--json"],
        ["campaigns", "get", "camp_1234567890abcdefgh", "--json"],
        [
          "campaigns",
          "runs",
          "create",
          "camp_1234567890abcdefgh",
          "--at",
          "2026-08-01T09:00:00Z",
          "--idempotency-key",
          "launch-august",
          "--json",
        ],
        ["campaigns", "runs", "list", "camp_1234567890abcdefgh", "--json"],
        [
          "campaigns",
          "runs",
          "get",
          "camp_1234567890abcdefgh",
          "crun_1234567890abcdefgh",
          "--json",
        ],
        [
          "campaigns",
          "runs",
          "pause",
          "camp_1234567890abcdefgh",
          "crun_1234567890abcdefgh",
          "--json",
        ],
        [
          "campaigns",
          "runs",
          "resume",
          "camp_1234567890abcdefgh",
          "crun_1234567890abcdefgh",
          "--json",
        ],
        [
          "campaigns",
          "runs",
          "cancel",
          "camp_1234567890abcdefgh",
          "crun_1234567890abcdefgh",
          "--yes",
          "--json",
        ],
        [
          "campaigns",
          "runs",
          "recipients",
          "camp_1234567890abcdefgh",
          "crun_1234567890abcdefgh",
          "--json",
        ],
      ] as const;
      for (const command of commands) {
        const result = await runCli(command, { env });
        expect(result.code, `${command.join(" ")}\n${result.stderr}`).toBe(0);
        expect(result.stderr).toBe("");
        expect(() => JSON.parse(result.stdout)).not.toThrow();
      }
      expect(api.requests).toEqual([
        {
          method: "POST",
          path: "/v1/campaigns",
          body: {
            name: "Launch",
            channel: "email",
            content: {
              channel: "email",
              email: { templateSlug: "launch", tracking: { clicks: false } },
            },
            audience: { topicId: "unsub_1234567890abcdef", includeTags: ["newsletter"] },
          },
        },
        {
          method: "PATCH",
          path: "/v1/campaigns/camp_1234567890abcdefgh",
          body: {
            name: "Launch v2",
            content: {
              channel: "email",
              email: { templateSlug: "launch-v2", tracking: { opens: false } },
            },
          },
        },
        { method: "GET", path: "/v1/campaigns", body: null },
        { method: "GET", path: "/v1/campaigns/camp_1234567890abcdefgh", body: null },
        {
          method: "POST",
          path: "/v1/campaigns/camp_1234567890abcdefgh/runs",
          body: { scheduledFor: "2026-08-01T09:00:00.000Z", idempotencyKey: "launch-august" },
        },
        { method: "GET", path: "/v1/campaigns/camp_1234567890abcdefgh/runs", body: null },
        {
          method: "GET",
          path: "/v1/campaigns/camp_1234567890abcdefgh/runs/crun_1234567890abcdefgh",
          body: null,
        },
        {
          method: "POST",
          path: "/v1/campaigns/camp_1234567890abcdefgh/runs/crun_1234567890abcdefgh/pause",
          body: null,
        },
        {
          method: "POST",
          path: "/v1/campaigns/camp_1234567890abcdefgh/runs/crun_1234567890abcdefgh/resume",
          body: null,
        },
        {
          method: "POST",
          path: "/v1/campaigns/camp_1234567890abcdefgh/runs/crun_1234567890abcdefgh/cancel",
          body: null,
        },
        {
          method: "GET",
          path: "/v1/campaigns/camp_1234567890abcdefgh/runs/crun_1234567890abcdefgh/recipients",
          body: null,
        },
      ]);
    } finally {
      await api.close();
    }
  });
});

describe("credential precedence", () => {
  it("SAMVA_API_KEY wins without reading stored OAuth credentials or organization", async () => {
    const samvaConfig = join(configHome, "samva");
    await mkdir(samvaConfig, { recursive: true });
    await writeFile(
      join(samvaConfig, "config.json"),
      JSON.stringify({
        version: 2,
        profiles: { default: { credentialIdentity: "none" } },
      }),
    );

    const { code, stdout, stderr } = await runCli(
      [
        "email",
        "send",
        "--to",
        "a@b.com",
        "--subject",
        "Hi",
        "--text",
        "Hello",
        "--dry-run",
        "--json",
      ],
      {
        env: {
          SAMVA_API_KEY: "samva_sk_test_env_wins",
          SAMVA_API_URL: DEV_URL,
        },
      },
    );

    expect(code).toBe(0);
    expect(parseResult(stdout)).toMatchObject({ dryRun: true });
    expect(stderr).toBe("");

    await rm(join(samvaConfig, "config.json"));
  });
});

describe("--log-level none leaves data intact", () => {
  it("keeps the JSON payload on stdout with status fully silenced", async () => {
    const { stdout } = await runCli([
      "email",
      "send",
      "--to",
      "a@b.com",
      "--subject",
      "Hi",
      "--text",
      "Hello",
      "--dry-run",
      "--json",
      "--log-level",
      "none",
    ]);
    const parsed = parseResult<{ dryRun: boolean }>(stdout);
    expect(parsed.dryRun).toBe(true);
  });
});

describe("stream separation (human mode)", () => {
  it("keeps non-TTY progress off both streams while preserving result data", async () => {
    const { stdout, stderr } = await runCli(
      ["email", "send", "--to", "a@b.com", "--subject", "Hi", "--text", "Hello", "--dry-run"],
      { env: { SAMVA_API_KEY: "samva_sk_test_x" } },
    );
    expect(stdout).toContain("Subject");
    expect(stdout).not.toContain("Dry run — no API request sent.");
    expect(stderr).toBe("");
  });
});

describe("honest exit codes on failure", () => {
  it("preserves the latest Message JSON on a lifecycle timeout", async () => {
    const api = await startPendingMessageApi();
    try {
      const result = await runCli(
        ["messages", "wait", "msg_1234567890abcdefgh", "--timeout", "1 millis", "--json"],
        { env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url } },
      );
      expect(result.code).toBe(124);
      const envelope = JSON.parse(result.stdout) as MachineResult<{
        readonly id: string;
        readonly status: string;
      }>;
      expect(envelope).toMatchObject({
        schemaVersion: 1,
        type: "result",
        partial: true,
        data: {
          id: "msg_1234567890abcdefgh",
          status: "sent",
        },
      });
      expect(JSON.parse(result.stderr)).toMatchObject({ reason: "message_wait_timeout" });
    } finally {
      await api.close();
    }
  });

  it("rejects --timeout without --wait even for a dry-run", async () => {
    const result = await runCli([
      "email",
      "send",
      "--to",
      "a@b.com",
      "--subject",
      "Hi",
      "--text",
      "Hello",
      "--timeout",
      "2m",
      "--dry-run",
      "--json",
    ]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ reason: "timeout_requires_wait" });
  });

  it("reports an email's sending address from messages get", async () => {
    const api = await startPendingMessageApi();
    try {
      const result = await runCli(["messages", "get", "msg_1234567890abcdefgh", "--json"], {
        env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url },
      });
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(parseResult(result.stdout)).toMatchObject({ from: "hello@example.com" });
    } finally {
      await api.close();
    }
  });

  it("lets the retry schedule own the message polling interval", async () => {
    const api = await startPendingMessageApi({ deliverOnRead: 3 });
    try {
      const result = await runCli(
        ["messages", "wait", "msg_1234567890abcdefgh", "--timeout", "5s", "--json"],
        { env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url } },
      );
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(parseResult(result.stdout)).toMatchObject({ status: "delivered" });
      // The schedule, not a fixed sleep, decides when to re-read: the API turns
      // the message delivered on its third read, so the CLI must have issued
      // exactly three reads and stopped at the first terminal observation.
      expect(api.messageReads()).toBe(3);
    } finally {
      await api.close();
    }
  });

  it("preserves the last observation after a messages wait polling failure", async () => {
    const api = await startPendingMessageApi({ failMessageAfterRead: 2 });
    try {
      const result = await runCli(
        ["messages", "wait", "msg_1234567890abcdefgh", "--timeout", "5s", "--json"],
        { env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url } },
      );
      expect(result.code).toBe(4);
      expect(JSON.parse(result.stdout)).toMatchObject({
        command: "messages.wait",
        partial: true,
        data: { id: "msg_1234567890abcdefgh", status: "sent" },
      });
      expect(JSON.parse(result.stderr)).toMatchObject({
        reason: "UnauthorizedError",
        next: expect.stringContaining("samva login"),
      });
      expect(result.stderr).toContain("credential revoked");
    } finally {
      await api.close();
    }
  });

  it("keeps stdout empty when the initial messages wait read fails", async () => {
    const api = await startPendingMessageApi({ failMessageAfterRead: 1 });
    try {
      const result = await runCli(
        ["messages", "wait", "msg_1234567890abcdefgh", "--timeout", "5s", "--json"],
        { env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url } },
      );
      expect(result.code).toBe(4);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({ reason: "UnauthorizedError", status: 401 });
    } finally {
      await api.close();
    }
  });

  it("preserves an accepted send when its later observation fails", async () => {
    const api = await startPendingMessageApi({ failMessageAfterRead: 1 });
    try {
      const result = await runCli(
        [
          "email",
          "send",
          "--to",
          "a@b.com",
          "--subject",
          "Hi",
          "--text",
          "Hello",
          "--wait",
          "--timeout",
          "5s",
          "--json",
        ],
        { env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url } },
      );
      expect(result.code).toBe(4);
      expect(JSON.parse(result.stdout)).toMatchObject({
        command: "email.send",
        partial: true,
        data: { id: "msg_1234567890abcdefgh", status: "sent" },
      });
      expect(JSON.parse(result.stderr)).toMatchObject({
        reason: "UnauthorizedError",
        next: expect.stringContaining("samva login"),
      });
    } finally {
      await api.close();
    }
  });

  it("forwards --direction to the messages list query", async () => {
    const api = await startPendingMessageApi();
    try {
      const env = { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url };
      const result = await runCli(
        ["messages", "list", "--direction", "inbound", "--channel", "email", "--json"],
        { env },
      );
      expect(result).toMatchObject({ code: 0, stderr: "" });
      const [query] = api.listQueries();
      expect(query).toBeDefined();
      const params = new URLSearchParams(query);
      expect(params.get("direction")).toBe("inbound");
      expect(params.get("channel")).toBe("email");
    } finally {
      await api.close();
    }
  });

  it("uses the same flat JSONL resource envelope for bounded and unbounded lists", async () => {
    const api = await startPendingMessageApi();
    try {
      const env = { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url };
      const bounded = await runCli(["messages", "list", "--limit", "1", "--jsonl"], { env });
      expect(bounded).toMatchObject({ code: 0, stderr: "" });
      const boundedRows = bounded.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(boundedRows).toEqual([
        {
          schemaVersion: 1,
          type: "result",
          command: "messages.list",
          data: expect.objectContaining({ id: "msg_1234567890abcdefgh" }),
        },
      ]);

      const unbounded = await runCli(["messages", "list", "--all", "--jsonl"], { env });
      expect(unbounded).toMatchObject({ code: 0, stderr: "" });
      const unboundedRows = unbounded.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(unboundedRows).toEqual([
        {
          schemaVersion: 1,
          type: "result",
          command: "messages.list",
          data: expect.objectContaining({ id: "msg_1234567890abcdefgh" }),
        },
        {
          schemaVersion: 1,
          type: "result",
          command: "messages.list",
          data: expect.objectContaining({ id: "msg_2234567890abcdefgh" }),
        },
      ]);
    } finally {
      await api.close();
    }
  });

  it.each([
    ["campaigns.list", ["campaigns", "list"], "camp_1234567890abcdefgh"],
    [
      "campaigns.runs.list",
      ["campaigns", "runs", "list", "camp_1234567890abcdefgh"],
      "crun_1234567890abcdefgh",
    ],
    [
      "campaigns.runs.recipients",
      ["campaigns", "runs", "recipients", "camp_1234567890abcdefgh", "crun_1234567890abcdefgh"],
      "crcpt_1234567890abcdef",
    ],
    ["email.domains.list", ["email", "domains", "list"], "dom_1234567890abcdefgh"],
    ["email.senders.list", ["email", "senders", "list"], "sender_1234567890abcdef"],
    ["templates.list", ["templates", "list"], "tmpl_1234567890abcdef"],
    ["webhooks.list", ["webhooks", "list"], "wep_1234567890abcdef"],
    ["scheduled-messages.list", ["scheduled-messages", "list"], "sched_1234567890abcdefgh"],
  ] as const)("%s emits one flat bounded JSONL resource record", async (command, args, id) => {
    const api = await startApi();
    try {
      const result = await runCli([...args, "--limit", "1", "--jsonl"], {
        env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url },
      });
      expect(result).toMatchObject({ code: 0, stderr: "" });
      const lines = result.stdout.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toEqual({
        schemaVersion: 1,
        type: "result",
        command,
        data: expect.objectContaining({ id }),
      });
    } finally {
      await api.close();
    }
  });

  it.each([
    ["campaigns.list", ["campaigns", "list"]],
    ["email.domains.list", ["email", "domains", "list"]],
    ["email.senders.list", ["email", "senders", "list"]],
    ["templates.list", ["templates", "list"]],
    ["webhooks.list", ["webhooks", "list"]],
    ["scheduled-messages.list", ["scheduled-messages", "list"]],
  ] as const)("%s --json keeps the page's nextCursor", async (_command, args) => {
    // Without the cursor a caller has no way to ask for the next page.
    const api = await startApi();
    try {
      const result = await runCli([...args, "--limit", "1", "--json"], {
        env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url },
      });
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout).data).toHaveProperty("nextCursor", null);
    } finally {
      await api.close();
    }
  });

  it("emits no JSONL records for empty bounded or unbounded lists", async () => {
    const api = await startPendingMessageApi({ emptyMessages: true });
    try {
      const env = { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url };
      for (const args of [
        ["messages", "list", "--jsonl"],
        ["messages", "list", "--all", "--jsonl"],
      ]) {
        const result = await runCli(args, { env });
        expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
      }
    } finally {
      await api.close();
    }
  });

  it("streams flat JSONL page by page and preserves completed rows on later failure", async () => {
    const api = await startPendingMessageApi({ failSecondPage: true });
    try {
      const result = await runCli(["messages", "list", "--all", "--jsonl"], {
        env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url },
      });
      expect(result.code).toBe(1);
      const rows = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows).toEqual([
        expect.objectContaining({
          schemaVersion: 1,
          type: "result",
          command: "messages.list",
          data: expect.objectContaining({ id: "msg_1234567890abcdefgh" }),
        }),
      ]);
      expect(JSON.parse(result.stderr)).toMatchObject({ type: "error" });
    } finally {
      await api.close();
    }
  });

  it("uses the conventional 130 exit for SIGINT", async () => {
    const oauth = await startPendingOAuth();
    const result = await new Promise<CliResult>((resolve, reject) => {
      const child = spawnCli(["login", "--no-browser", "--api-url", oauth.url], { configHome });
      let stdout = "";
      let stderr = "";
      let interrupted = false;
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
        if (!interrupted && stderr.includes("TEST-CODE")) {
          interrupted = true;
          child.kill("SIGINT");
        }
      });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timeout);
        resolve({ code: code ?? 0, stdout, stderr });
      });
    });
    await oauth.close();
    expect(result.code).toBe(130);
    expect(result.stdout).toBe("");
  });

  it("emits a JSON diagnostic on stderr with empty stdout for an edge failure", async () => {
    const { code, stdout, stderr } = await runCli(["org", "list", "--json"], {
      env: {
        SAMVA_API_URL: "http://127.0.0.1:1",
        SAMVA_API_KEY: "samva_sk_test_invalid",
      },
    });
    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    const parsed = JSON.parse(stderr) as { type: string; message: string };
    expect(parsed.type).toBe("error");
    expect(parsed.message.length).toBeGreaterThan(0);
  });

  it("does not emit a partial payload for a context failure", async () => {
    const { code, stdout, stderr } = await runCli(["org", "current", "--json"]);
    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({ type: "error" });
  });
});

describe("email doctor", () => {
  it("uses only read requests and never prints credential material", async () => {
    const api = await startDoctorApi();
    const secret = "samva_sk_secret_should_not_leak";
    try {
      const result = await runCli(["email", "doctor", "--json"], {
        env: { SAMVA_API_KEY: secret, SAMVA_API_URL: api.url },
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(parseResult(result.stdout)).toMatchObject({
        schemaVersion: 1,
        mode: "read-only",
        ok: true,
        resolved: { authSource: "SAMVA_API_KEY" },
      });
      expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
      expect(api.requests.length).toBeGreaterThan(0);
      expect(api.requests.every((request) => request.method === "GET")).toBe(true);
    } finally {
      await api.close();
    }
  });
});

describe("email launch mutation contracts", () => {
  it("template dry-run omits subject from the request", async () => {
    const { code, stdout, stderr } = await runCli(
      [
        "email",
        "send",
        "--to",
        "a@b.com",
        "--template-slug",
        "welcome-email",
        "--dry-run",
        "--json",
      ],
      { env: { SAMVA_API_KEY: "samva_sk_test_x" } },
    );
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const parsed = parseResult<{ request: Record<string, unknown> }>(stdout);
    expect(parsed.request).not.toHaveProperty("subject");
    expect(parsed.request.templateSlug).toBe("welcome-email");
  });

  it("rejects an explicit subject on a template send", async () => {
    const { code, stderr } = await runCli([
      "email",
      "send",
      "--to",
      "a@b.com",
      "--template-slug",
      "welcome-email",
      "--subject",
      "Wrong",
      "--dry-run",
    ]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("Omit --subject");
  });

  it.each([
    ["domains", "dom_abc123"],
    ["senders", "sender_abc123"],
  ] as const)("%s remove dry-run is JSON-pure and needs no auth", async (resource, id) => {
    const { code, stdout, stderr } = await runCli([
      "email",
      resource,
      "remove",
      id,
      "--dry-run",
      "--json",
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(parseResult(stdout)).toMatchObject({ dryRun: true, id });
  });

  it.each([
    ["campaigns", "archive", "camp_abc123"],
    ["campaigns", "runs", "cancel", "camp_abc123", "crun_def456"],
    ["scheduled-messages", "cancel", "sched_abc123"],
  ] as const)(
    "%s destructive path requires --yes and has an offline --dry-run",
    async (...command) => {
      const rejected = await runCli([...command, "--json"]);
      expect(rejected.code).toBe(2);
      expect(rejected.stdout).toBe("");
      expect(JSON.parse(rejected.stderr)).toMatchObject({ reason: "confirmation_required" });

      const preview = await runCli([...command, "--dry-run", "--json"]);
      expect(preview.code).toBe(0);
      expect(preview.stderr).toBe("");
      expect(parseResult(preview.stdout)).toMatchObject({ dryRun: true });
    },
  );

  it("secret rotation refuses non-interactive apply without --yes", async () => {
    const { code, stdout, stderr } = await runCli([
      "webhooks",
      "rotate-secret",
      "wep_1234567890abcdef",
      "--json",
    ]);
    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({ type: "error" });
    expect(stderr).toContain("--yes");
  });

  it("receiving enable dry-run is offline and deterministic", async () => {
    const result = await runCli([
      "email",
      "receiving",
      "enable",
      "dom_abc123",
      "--domain",
      "example.com",
      "--address",
      "replies@example.com",
      "--catch-all",
      "--dry-run",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseResult(result.stdout)).toMatchObject({
      dryRun: true,
      action: "email.receiving.enable",
      request: { domain: "example.com", catchAll: true, addresses: ["replies@example.com"] },
    });
  });

  it("receiving enable --catch-all needs no address and carries the webhook endpoint", async () => {
    const result = await runCli([
      "email",
      "receiving",
      "enable",
      "dom_abc123",
      "--domain",
      "example.com",
      "--catch-all",
      "--endpoint",
      "wep_1234567890abcdef",
      "--dry-run",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(parseResult(result.stdout)).toMatchObject({
      request: {
        domain: "example.com",
        catchAll: true,
        addresses: [],
        endpointId: "wep_1234567890abcdef",
      },
    });
  });

  it.each([
    ["no address and no --catch-all", [], "--catch-all"],
    [
      "--endpoint without --catch-all",
      ["--address", "a@example.com", "--endpoint", "wep_x"],
      "--catch-all",
    ],
  ] as const)("receiving enable refuses %s", async (_name, flags, hint) => {
    const result = await runCli([
      "email",
      "receiving",
      "enable",
      "dom_abc123",
      "--domain",
      "example.com",
      ...flags,
      "--dry-run",
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(hint);
  });

  it("receiving status lists each prerequisite and names where the MX points", async () => {
    const api = await startPendingMessageApi();
    try {
      const env = { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url };
      const human = await runCli(["email", "receiving", "status", "dom_1234567890abcdefgh"], {
        env,
      });
      expect(human.code).toBe(0);
      expect(human.stdout).toContain("2 forwarding rules, 1 mailbox");
      expect(human.stdout).toContain("route1.mx.cloudflare.net");
      expect(human.stdout).toContain("inbound-smtp.us-east-1.amazonaws.com");
      const json = await runCli(
        ["email", "receiving", "status", "dom_1234567890abcdefgh", "--json"],
        { env },
      );
      expect(parseResult(json.stdout)).toMatchObject({ ready: false, mx: { state: "elsewhere" } });
    } finally {
      await api.close();
    }
  });

  it("receiving enable applies without --yes in non-interactive mode", async () => {
    const api = await startPendingMessageApi();
    try {
      const result = await runCli(
        [
          "email",
          "receiving",
          "enable",
          "dom_1234567890abcdefgh",
          "--domain",
          "example.com",
          "--address",
          "replies@example.com",
          "--json",
        ],
        { env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url } },
      );
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(parseResult(result.stdout)).toEqual({
        success: true,
        recipients: ["replies@example.com"],
      });
    } finally {
      await api.close();
    }
  });

  it("webhook create help uses the API eventTypes field", async () => {
    const result = await runCli(["webhooks", "create", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("eventTypes");
    expect(result.stdout).not.toContain('"events":');
  });

  it.each([
    [
      "create",
      [
        "--data",
        '{"name":"Hook","url":"https://example.com/hook","eventTypes":["message.delivered"]}',
      ],
    ],
    ["update", ["wep_1234567890abcdef", "--data", '{"status":"disabled"}']],
    ["test", ["wep_1234567890abcdef", "--data", '{"event":"webhook.test"}']],
    ["remove", ["wep_1234567890abcdef"]],
  ] as const)("webhook %s dry-run does not require auth", async (command, args) => {
    const result = await runCli(["webhooks", command, ...args, "--dry-run", "--json"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseResult(result.stdout)).toMatchObject({ dryRun: true });
  });

  it("accepts every webhook event type in a webhook's eventTypes", async () => {
    const eventTypes = [...WEBHOOK_EVENT_TYPE_VALUES];
    const data = JSON.stringify({ name: "Hook", url: "https://example.com/hook", eventTypes });
    const result = await runCli(["webhooks", "create", "--data", data, "--dry-run", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(parseResult(result.stdout)).toMatchObject({ request: { eventTypes } });
  });

  it("tests a webhook with inline and @file payloads against a local API", async () => {
    const api = await startApi();
    const dataFile = join(configHome, "webhook-test-payload.json");
    await writeFile(dataFile, JSON.stringify({ event: "webhook.test", source: "file" }));
    const env = { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url };
    try {
      const inline = await runCli(
        [
          "webhooks",
          "test",
          "wep_1234567890abcdef",
          "--data",
          '{"event":"webhook.test","source":"inline"}',
          "--json",
        ],
        { env },
      );
      expect(inline.code, inline.stderr).toBe(0);
      expect(inline.stderr).toBe("");
      expect(parseResult(inline.stdout)).toEqual({
        accepted: true,
        eventId: "whevt_1234567890abcdef",
        deliveryId: "whdel_1234567890abcdef",
      });
      expect(api.requests.at(-1)).toMatchObject({
        method: "POST",
        path: "/v1/webhooks/wep_1234567890abcdef/test",
        body: { data: { event: "webhook.test", source: "inline" } },
      });

      const file = await runCli(
        ["webhooks", "test", "wep_1234567890abcdef", "--data", `@${dataFile}`, "--json"],
        { env },
      );
      expect(file.code).toBe(0);
      expect(parseResult(file.stdout)).toMatchObject({ accepted: true });
      expect(api.requests.at(-1)?.body).toEqual({
        data: { event: "webhook.test", source: "file" },
      });
    } finally {
      await api.close();
    }
  });

  it("requires JSONL for unbounded list traversal before resolving credentials", async () => {
    const result = await runCli(["messages", "list", "--all", "--json"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ reason: "all_requires_jsonl" });
  });

  it.each([
    [
      "create",
      [
        "--data",
        '{"name":"Welcome","projectName":"welcome-email","idempotencyKey":"welcome-email-v1"}',
      ],
    ],
    ["update", ["tmpl_abc123", "--data", '{"name":"Welcome back"}']],
    ["remove", ["tmpl_abc123"]],
  ] as const)("template %s dry-run does not require auth", async (command, args) => {
    const result = await runCli(["templates", command, ...args, "--dry-run", "--json"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseResult(result.stdout)).toMatchObject({ dryRun: true });
  });

  it("template create --shared puts shared in the dry-run request", async () => {
    const result = await runCli([
      "templates",
      "create",
      "--data",
      '{"name":"Welcome","idempotencyKey":"welcome-email-v1"}',
      "--shared",
      "--dry-run",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(parseResult(result.stdout)).toMatchObject({ request: { shared: true } });
  });

  it.each([
    [
      "shared: false in --data",
      ['{"name":"Welcome","idempotencyKey":"k","shared":false}'],
      "shared_conflict",
    ],
    [
      "--namespace",
      ['{"name":"Welcome","idempotencyKey":"k"}', "--namespace", "ns_3xk9mvt4znw8rh7q"],
      "shared_namespace_conflict",
    ],
    [
      "namespaceId in --data",
      ['{"name":"Welcome","idempotencyKey":"k","namespaceId":"ns_3xk9mvt4znw8rh7q"}'],
      "shared_namespace_conflict",
    ],
  ] as const)("template create --shared refuses %s", async (_label, [data, ...rest], reason) => {
    const result = await runCli([
      "templates",
      "create",
      "--data",
      data,
      ...rest,
      "--shared",
      "--dry-run",
      "--json",
    ]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ reason });
  });

  it.each([
    ["true", true],
    ["false", false],
  ] as const)("template update --shared %s sets data.shared", async (value, expected) => {
    const result = await runCli([
      "templates",
      "update",
      "tmpl_abc123",
      "--data",
      "{}",
      "--shared",
      value,
      "--dry-run",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(parseResult(result.stdout)).toMatchObject({ request: { data: { shared: expected } } });
  });

  it("template update --shared refuses a disagreeing shared in --data", async () => {
    const result = await runCli([
      "templates",
      "update",
      "tmpl_abc123",
      "--data",
      '{"shared":true}',
      "--shared",
      "false",
      "--dry-run",
      "--json",
    ]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ reason: "shared_conflict" });
  });

  it("template update --shared sends data.shared to the API", async () => {
    const api = await startApi();
    try {
      const env = { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url };
      const result = await runCli(
        [
          "templates",
          "update",
          "tmpl_1234567890abcdef",
          "--data",
          "{}",
          "--shared",
          "true",
          "--json",
        ],
        { env },
      );
      expect(result).toMatchObject({ code: 0, stderr: "" });
      const request = api.requests.find(
        (r) => r.method === "PATCH" && r.path.startsWith("/v1/templates/tmpl_1234567890abcdef"),
      );
      expect(request?.body).toMatchObject({ data: { shared: true } });
    } finally {
      await api.close();
    }
  });

  it("template list --shared sends the filter and human output shows Shared", async () => {
    const api = await startApi();
    try {
      const env = { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url };
      const result = await runCli(["templates", "list", "--shared", "true"], { env });
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(result.stdout).toContain("Shared");
      expect(
        api.requests.some(
          (r) => r.path.startsWith("/v1/templates") && r.path.includes("shared=true"),
        ),
      ).toBe(true);
    } finally {
      await api.close();
    }
  });

  it.each(["null", "[]", "true", '"text"', "42"])(
    "rejects non-object --data value %s",
    async (data) => {
      const result = await runCli(["webhooks", "create", "--data", data, "--dry-run", "--json"]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("non-null JSON object");
    },
  );

  it("returns a created webhook's signing secret without display-once metadata", async () => {
    const api = await startApi();
    try {
      const result = await runCli(
        [
          "webhooks",
          "create",
          "--data",
          '{"name":"Delivery","url":"https://example.com/hook","eventTypes":["message.delivered"]}',
          "--json",
        ],
        { env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url } },
      );
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(parseResult(result.stdout)).toEqual({
        endpoint: expect.objectContaining({ id: "wep_1234567890abcdef", name: "Delivery" }),
        secret: "whsec_created_once",
        warning: "Read this signing secret again with samva webhooks secret wep_1234567890abcdef.",
      });
    } finally {
      await api.close();
    }
  });

  it("prints a created webhook's signing secret in human output, warning on stderr", async () => {
    const api = await startApi();
    try {
      const result = await runCli(
        [
          "webhooks",
          "create",
          "--data",
          '{"name":"Delivery","url":"https://example.com/hook","eventTypes":["message.delivered"]}',
        ],
        { env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url } },
      );
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/^Signing secret\s+whsec_created_once$/m);
      expect(result.stdout).toContain("wep_1234567890abcdef");
      expect(result.stdout).not.toContain("<redacted>");
      expect(result.stderr).toContain(
        "WARNING: Read this signing secret again with samva webhooks secret wep_1234567890abcdef.",
      );
    } finally {
      await api.close();
    }
  });

  it("returns a rotated secret without display-once metadata", async () => {
    const api = await startApi();
    try {
      const result = await runCli(
        ["webhooks", "rotate-secret", "wep_1234567890abcdef", "--yes", "--json"],
        { env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url } },
      );
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(parseResult(result.stdout)).toEqual({
        secret: "whsec_display_once",
        warning:
          "Read this signing secret again with samva webhooks secret wep_1234567890abcdef. The previous secret remains valid for 24 hours.",
      });
    } finally {
      await api.close();
    }
  });
});

describe("Email Launch public command surface", () => {
  it("keeps excluded product families out of root help", async () => {
    const { code, stdout, stderr } = await runCli(["--help"]);
    const help = `${stdout}\n${stderr}`;

    expect(code).toBe(0);
    for (const excluded of ["sms", "whatsapp", "voice", "smtp"]) {
      expect(help).not.toMatch(new RegExp(`\\b${excluded}\\b`, "i"));
    }
    for (const included of [
      "email",
      "messages",
      "scheduled-messages",
      "campaigns",
      "templates",
      "mailboxes",
      "extensions",
      "webhooks",
    ]) {
      expect(help).toMatch(new RegExp(`\\b${included}\\b`, "i"));
    }
  });
});

describe("envelope command names", () => {
  // The released command tree, read from the registry that parses argv.
  interface Node {
    readonly name: string;
    readonly subcommands: ReadonlyArray<{ readonly commands: ReadonlyArray<Node> }>;
  }
  const leafPaths = (node: Node, prefix: ReadonlyArray<string>): Array<Array<string>> => {
    const path = [...prefix, node.name];
    const children = node.subcommands.flatMap((group) => group.commands);
    return children.length === 0 ? [path] : children.flatMap((child) => leafPaths(child, path));
  };
  const paths = (rootCommands as ReadonlyArray<Node>).flatMap((command) => leafPaths(command, []));

  it("names every released command path, not its parent", () => {
    const misnamed = paths.filter((path) => commandNameFromArgv(path) !== path.join("."));
    expect(misnamed).toEqual([]);
  });

  it.each([
    ["email.review.status", ["email", "review", "status"]],
    ["email.tracking.defaults.get", ["email", "tracking", "defaults", "get"]],
    [
      "templates.workspace.add-asset",
      [
        "templates",
        "workspace",
        "add-asset",
        "tmpl_1234567890abcdef",
        "missing.png",
        "--revision",
        "1",
        "--idempotency-key",
        "asset-1",
      ],
    ],
  ] as const)("%s failures carry their own command name", async (command, args) => {
    const result = await runCli([...args, "--json"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "error", command });
  });
});

describe("API failure recovery envelopes", () => {
  it.each([
    [
      422,
      {
        _tag: "ValidationError",
        message: "Invalid request",
        fields: { "email.tracking.typo": ["Unexpected property"] },
      },
      1,
    ],
    [
      401,
      {
        _tag: "UnauthorizedError",
        message: "API key is revoked. Send an active key using Authorization: Bearer <key>.",
      },
      4,
    ],
    [
      403,
      {
        _tag: "ForbiddenError",
        message: "API key requires messages:read scope; use a key with this scope.",
      },
      4,
    ],
    [500, { _tag: "InternalError", message: "Service temporarily unavailable" }, 1],
  ])("preserves API %s diagnostics in JSON and human modes", async (status, body, code) => {
    const server = createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const env = { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: `http://127.0.0.1:${port}` };
    try {
      const json = await runCli(["messages", "list", "--json"], { env });
      expect(json.code).toBe(code);
      expect(json.stdout).toBe("");
      expect(JSON.parse(json.stderr)).toMatchObject({
        type: "error",
        reason: body._tag,
        status,
        message: body.message,
        details: {},
        next: expect.any(String),
      });
      if ("fields" in body) expect(JSON.parse(json.stderr).details.fields).toEqual(body.fields);
      const human = await runCli(["messages", "list"], { env });
      expect(human.code).toBe(code);
      expect(human.stderr).toContain(body.message);
      expect(human.stderr).toContain("Try:");
      if ("fields" in body)
        expect(human.stderr).toContain("email.tracking.typo: Unexpected property");
      if (status === 401) expect(human.stderr).toContain("samva login");
      if (status === 500) expect(human.stderr).toContain("samva feedback send");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("send acceptance guidance", () => {
  it("reports content-review hold and skipped recipient in both output modes", async () => {
    const api = await startPendingMessageApi({ heldSend: true });
    const env = { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url };
    const args = ["email", "send", "--to", "a@b.com", "--subject", "Hi", "--text", "Hello"];
    try {
      const json = await runCli([...args, "--json"], { env });
      expect(json.code).toBe(0);
      expect(parseResult(json.stdout)).toMatchObject({
        status: "queued",
        waitReason: "content-review",
        reviewExpectedAt: "2026-07-21T00:10:00.000Z",
        skippedRecipients: [{ address: "blocked@example.com", reason: "bounce" }],
      });
      const human = await runCli(args, { env });
      expect(human.code).toBe(0);
      expect(human.stdout).toContain("content review");
      expect(human.stdout).toContain("2026-07-21T00:10:00.000Z");
      expect(human.stdout).toContain("blocked@example.com (bounce)");
    } finally {
      await api.close();
    }
  });
});

describe("subscription requests", () => {
  it("forwards signup context and exposes acceptance without confirming for the recipient", async () => {
    const api = await startApi();
    try {
      const args = [
        "subscriptions",
        "subscribe",
        "--email",
        "ada@example.com",
        "--from",
        "news@example.com",
        "--from-name",
        "Newsletter",
        "--topic-id",
        "unsub_1234567890abcdef",
        "--template-slug",
        "confirm-newsletter",
        "--consent-ip",
        "203.0.113.1",
        "--consent-source",
        "signup-form",
      ];
      const env = { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url };
      const machine = await runCli([...args, "--json"], { env });
      expect(machine.code).toBe(0);
      expect(machine.stderr).toBe("");
      expect(parseResult(machine.stdout)).toEqual({
        success: true,
        expiresAt: "2026-09-08T00:00:00.000Z",
      });
      expect(JSON.parse(machine.stdout)).toMatchObject({ command: "subscriptions.subscribe" });
      expect(api.requests).toEqual([
        {
          method: "POST",
          path: "/v1/subscriptions",
          body: {
            email: "ada@example.com",
            from: { email: "news@example.com", name: "Newsletter" },
            topicId: "unsub_1234567890abcdef",
            templateSlug: "confirm-newsletter",
            consentIp: "203.0.113.1",
            consentSource: "signup-form",
          },
        },
      ]);
      const human = await runCli(args, { env });
      expect(human.code).toBe(0);
      expect(human.stdout).toContain("accepted: true");
      expect(human.stdout).toContain("2026-09-08");
      expect(human.stdout).toContain("awaits recipient confirmation");
      const confirm = await runCli(["subscriptions", "confirm", "--json"], { env });
      expect(confirm.code).toBe(2);
      expect(api.requests).toHaveLength(2);
    } finally {
      await api.close();
    }
  });
});
