import { mkdtemp, rm } from "node:fs/promises";
import { type AddressInfo, createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { type CliOptions, runCli as runCliProcess } from "./support/run-cli";

// Process-level contracts for `samva email`: which stdin body sources the send
// command accepts, which flag combinations it refuses before sending, and what
// `email doctor` reports and exits with. These run the real CLI as a subprocess.

let configHome = "";

const runCli = (args: ReadonlyArray<string>, options: Omit<CliOptions, "configHome"> = {}) =>
  runCliProcess(args, { configHome, ...options });

const organization = {
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
};

const verificationDetails = {
  provisioning: { status: "failed", generation: 2, revision: 3 },
  health: {
    reason: "dns-action-required",
    actionOwner: "customer",
    action: "Publish the required DNS records.",
    freshness: "current",
    observedAt: "2026-09-08T00:00:00.000Z",
    staleAt: "2026-09-08T00:15:00.000Z",
    nextRetryAt: null,
  },
  sending: {
    status: "blocked",
    reason: "domain-not-ready",
    actionOwner: "customer",
    action: "Complete domain verification.",
    freshness: "current",
    observedAt: "2026-09-08T00:00:00.000Z",
    staleAt: "2026-09-08T00:15:00.000Z",
    nextRetryAt: null,
  },
  dmarc: {
    status: "missing",
    source: "none",
    policyDomain: null,
    policy: null,
    subdomainPolicy: null,
    effectivePolicy: null,
    observedAt: "2026-09-08T00:00:00.000Z",
    staleAt: "2026-09-08T00:15:00.000Z",
    guidance: "Publish a DMARC policy.",
  },
  rotation: null,
};

const emptyPage = { items: [], nextCursor: null };

// Every domain list row carries the same computed blocks the API returns: a
// 24-hour deliverability reading with its denominator, and the 14-day series.
const zeroSeries = Array.from({ length: 14 }, () => 0);

const rejectedReview = {
  decision: "rejected",
  stage: "complete",
  trustTier: "screened",
  generation: 4,
  canSend: false,
  code: "review_rejected",
  nextAction: "reapply",
  canReapply: true,
  informationRequest: null,
  identities: [],
  updatedAt: "2026-09-12T12:00:00.000Z",
};

const approvedReview = {
  ...rejectedReview,
  decision: "approved",
  trustTier: "established",
  canSend: true,
  code: null,
  nextAction: null,
  canReapply: false,
};

const startReviewApi = (): Promise<{
  url: string;
  requests: Array<{ method: string | undefined; body: string }>;
  close: () => Promise<void>;
}> =>
  new Promise((resolve) => {
    const requests: Array<{ method: string | undefined; body: string }> = [];
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += String(chunk)));
      req.on("end", () => {
        requests.push({ method: req.method, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            req.method === "POST"
              ? {
                  ...rejectedReview,
                  decision: "undecided",
                  stage: "automated_review",
                  generation: 5,
                  code: "review_in_progress",
                  nextAction: "wait_for_review",
                  canReapply: false,
                }
              : rejectedReview,
          ),
        );
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

const trackingDomainId = "dom_1234567890abcdefgh";

const customTrackingBody = {
  enabled: true,
  parentDomains: ["send.example.com", "example.com"],
  customTracking: {
    status: "pending",
    label: "track",
    hostname: "track.example.com",
    parentDomain: "example.com",
    region: "us-east-1",
    sslStatus: "pending_validation",
    certificate: {
      reason: { code: "awaiting-dcv", message: "Waiting for the validation record to appear." },
      lastCheckedAt: "2026-10-10T12:00:00.000Z",
      nextCheckAt: "2026-10-10T12:00:20.000Z",
    },
    dnsRecords: {
      tracking: { type: "CNAME", name: "track.example.com", value: "tracking.samva.dev" },
      dcvDelegation: null,
    },
    caaBlocked: false,
    verificationErrors: [],
    teardownScheduledAt: null,
  },
};

const startCustomTrackingApi = (): Promise<{
  url: string;
  requests: Array<{ method: string | undefined; path: string; body: string }>;
  close: () => Promise<void>;
}> =>
  new Promise((resolve) => {
    const requests: Array<{ method: string | undefined; path: string; body: string }> = [];
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += String(chunk)));
      req.on("end", () => {
        requests.push({ method: req.method, path: req.url ?? "", body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(customTrackingBody));
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

/** A doctor-facing mock API. `breakOrg` returns an invalid org body so the org
 * check fails with a real, decodable error detail rather than "Read failed". */
const startDoctorApi = (
  options: {
    readonly breakOrg?: boolean | undefined;
    readonly domainPhase?: "ready" | "verifying" | "failed" | undefined;
    readonly review?: typeof rejectedReview | typeof approvedReview | undefined;
  } = {},
): Promise<{ url: string; close: () => Promise<void> }> =>
  new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const path = req.url ?? "/";
      if (path === "/v1/health/ping") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("pong");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (path.startsWith("/v1/organizations/current")) {
        res.end(JSON.stringify(options.breakOrg ? { unexpected: true } : organization));
        return;
      }
      if (
        path.startsWith("/v1/email/domains/dom_1234567890abcdefgh/verification") ||
        path === "/v1/email/domains/dom_1234567890abcdefgh/verify"
      ) {
        res.end(
          JSON.stringify({
            ...verificationDetails,
            domainId: "dom_1234567890abcdefgh",
            domain: "example.com",
            phase: options.domainPhase,
            dns: {
              observed: true,
              total: 0,
              satisfied: 0,
              missing: 0,
              mismatch: 0,
              unknown: 0,
            },
            requirements: [],
            provider: null,
            operationId: null,
            checkedAt: null,
            nextCheckAt: null,
            failure: null,
          }),
        );
        return;
      }
      if (path.startsWith("/v1/email/onboarding-review")) {
        res.end(JSON.stringify(options.review ?? approvedReview));
        return;
      }
      if (path.startsWith("/v1/email/domains")) {
        // `sendable=true` lists only ready domains, as the API does.
        const sendableOnly = new URL(path, "http://api.test").searchParams.get("sendable");
        const item =
          options.domainPhase && (sendableOnly !== "true" || options.domainPhase === "ready")
            ? {
                id: "dom_1234567890abcdefgh",
                namespaceId: null,
                domain: "example.com",
                phase: options.domainPhase,
                isDefault: false,
                deliverability: {
                  bounceRate: 0,
                  complaintRate: 0,
                  windowSends: 0,
                  sendingStatus: "unknown",
                },
                series: zeroSeries,
                createdAt: "2026-07-01T00:00:00.000Z",
                updatedAt: "2026-07-01T00:00:00.000Z",
              }
            : undefined;
        res.end(
          JSON.stringify({
            items: item ? [item] : [],
            nextCursor: null,
          }),
        );
        return;
      }
      res.end(JSON.stringify(emptyPage));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });

beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), "samva-cli-email-contract-"));
});

afterEach(async () => {
  if (configHome) await rm(configHome, { recursive: true, force: true });
});

describe("email send stdin bodies", () => {
  it("reads the HTML body from stdin when --html - is passed", async () => {
    const result = await runCli(
      ["email", "send", "--to", "a@b.com", "--subject", "Hi", "--html", "-", "--dry-run", "--json"],
      { stdin: "<p>Piped</p>" },
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: {
        bodySource: "stdin",
        request: { html: "<p>Piped</p>" },
      },
    });
  });

  it("rejects --text - and --html - together as competing stdin sources", async () => {
    const result = await runCli(
      [
        "email",
        "send",
        "--to",
        "a@b.com",
        "--subject",
        "Hi",
        "--text",
        "-",
        "--html",
        "-",
        "--dry-run",
        "--json",
      ],
      { stdin: "ambiguous" },
    );
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ reason: "multiple_stdin_bodies" });
  });
});

describe("email send --from", () => {
  const base = ["email", "send", "--to", "a@b.com", "--subject", "Hi", "--text", "Hi"];

  it("puts --from and --from-name in the request", async () => {
    const result = await runCli([
      ...base,
      "--from",
      "hello@acme.test",
      "--from-name",
      "Acme",
      "--dry-run",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { request: { from: { email: "hello@acme.test", name: "Acme" } } },
    });
  });

  it("omits from when --from is absent, and refuses --from-name alone", async () => {
    const omitted = await runCli([...base, "--dry-run", "--json"]);
    expect(JSON.parse(omitted.stdout).data.request).not.toHaveProperty("from");
    const nameOnly = await runCli([...base, "--from-name", "Acme", "--dry-run", "--json"]);
    expect(nameOnly.code).not.toBe(0);
  });
});

describe("email send wait guards", () => {
  it("rejects --dry-run --wait because a dry run sends nothing to wait on", async () => {
    const result = await runCli([
      "email",
      "send",
      "--to",
      "a@b.com",
      "--subject",
      "Hi",
      "--text",
      "Hello",
      "--dry-run",
      "--wait",
      "--json",
    ]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ reason: "dry_run_wait_conflict" });
  });
});

describe("email doctor exit contract", () => {
  it.each([
    ["ready", "passed", 0],
    ["verifying", "unavailable", 0],
    ["failed", "failed", 1],
    [undefined, "unavailable", 0],
  ] as const)(
    "maps %s domain verification to %s without claiming receiving configuration",
    async (domainPhase, expectedStatus, expectedCode) => {
      const api = await startDoctorApi({ domainPhase });
      try {
        const result = await runCli(["email", "doctor", "--json"], {
          env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url },
        });
        expect(result.code).toBe(expectedCode);
        const payload = (
          JSON.parse(result.stdout) as {
            data: { checks: ReadonlyArray<{ name: string; status: string; detail: string }> };
          }
        ).data;
        const check = payload.checks.find((item) => item.name === "Domain verification readback");
        expect(check?.status).toBe(expectedStatus);
        expect(JSON.stringify(payload)).not.toContain("Receiving configuration");
      } finally {
        await api.close();
      }
    },
  );

  it("exits 0 with ok:true when every check is healthy", async () => {
    const api = await startDoctorApi();
    try {
      const result = await runCli(["email", "doctor", "--json"], {
        env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url },
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const envelope = JSON.parse(result.stdout) as {
        data: {
          ok: boolean;
          checks: ReadonlyArray<{ name: string; status: string; detail: string }>;
        };
      };
      const payload = envelope.data;
      expect(payload.ok).toBe(true);
      expect(payload.checks.every((c) => c.status !== "failed")).toBe(true);
    } finally {
      await api.close();
    }
  });

  it.each([
    ["ready", true],
    ["verifying", false],
  ] as const)(
    "reports readyToSend for an approved review with a %s domain",
    async (domainPhase, readyToSend) => {
      const api = await startDoctorApi({ domainPhase });
      try {
        const result = await runCli(["email", "doctor", "--json"], {
          env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url },
        });
        expect(result.code).toBe(0);
        const payload = (
          JSON.parse(result.stdout) as {
            data: {
              readyToSend: boolean;
              checks: ReadonlyArray<{ name: string; status: string; detail: string }>;
            };
          }
        ).data;
        expect(payload.readyToSend).toBe(readyToSend);
        expect(payload.checks.find((c) => c.name === "Sending domains")?.detail).toBe(
          readyToSend ? "At least one sendable" : "None sendable",
        );
      } finally {
        await api.close();
      }
    },
  );

  it("fails the send review check with its next action when review is rejected", async () => {
    const api = await startDoctorApi({ domainPhase: "ready", review: rejectedReview });
    try {
      const result = await runCli(["email", "doctor", "--json"], {
        env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url },
      });
      expect(result.code).toBe(1);
      const payload = (
        JSON.parse(result.stdout) as {
          data: {
            readyToSend: boolean;
            checks: ReadonlyArray<{ name: string; status: string; detail: string }>;
          };
        }
      ).data;
      expect(payload.readyToSend).toBe(false);
      expect(payload.checks.find((c) => c.name === "Send review")).toMatchObject({
        status: "failed",
        detail: "review_rejected; next action: reapply",
      });
    } finally {
      await api.close();
    }
  });

  it("exits 1 with ok:false and a real error detail when a check fails", async () => {
    const api = await startDoctorApi({ breakOrg: true });
    try {
      const result = await runCli(["email", "doctor", "--json"], {
        env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url },
      });
      expect(result.code).toBe(1);
      const envelope = JSON.parse(result.stdout) as {
        data: {
          ok: boolean;
          checks: ReadonlyArray<{ name: string; status: string; detail: string }>;
        };
      };
      const payload = envelope.data;
      expect(payload.ok).toBe(false);
      const org = payload.checks.find((c) => c.name === "Organization permissions");
      expect(org?.status).toBe("failed");
      expect(org?.detail).not.toBe("Read failed");
      expect(org?.detail).toContain("Organization read failed");
    } finally {
      await api.close();
    }
  });
});

describe("email review commands", () => {
  it("keeps status reason and next action identical in machine output", async () => {
    const api = await startReviewApi();
    try {
      const result = await runCli(["email", "review", "status", "--json"], {
        env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url },
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).data).toMatchObject({
        decision: "rejected",
        code: "review_rejected",
        nextAction: "reapply",
        canReapply: true,
      });
    } finally {
      await api.close();
    }
  });

  it("reads the current generation before submitting reapplication", async () => {
    const api = await startReviewApi();
    try {
      const result = await runCli(["email", "review", "reapply", "--json"], {
        env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url },
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).data).toMatchObject({
        decision: "undecided",
        stage: "automated_review",
        code: "review_in_progress",
        nextAction: "wait_for_review",
      });
      expect(api.requests).toHaveLength(2);
      expect(api.requests[1]).toEqual({
        method: "POST",
        body: JSON.stringify({ expectedGeneration: 4 }),
      });
    } finally {
      await api.close();
    }
  });
});

describe("email domains rotate-dkim", () => {
  const receipt = {
    id: "rotation_1",
    domainId: "dom_aaaaaaaaaaaaaaaa",
    phase: "staged",
    selector: "new-selector",
    record: {
      name: "new-selector._domainkey.example.com",
      type: "TXT",
      value: "v=DKIM1; p=new",
      ttl: "600",
    },
    formerRecord: {
      name: "old-selector._domainkey.example.com",
      type: "TXT",
      value: "v=DKIM1; p=old",
    },
    minimumRetainUntil: "2026-09-09T00:00:00.000Z",
  };

  it("requires a bounded key and supports an unauthenticated no-write preview", async () => {
    for (const keyArgs of [[], ["--idempotency-key", ""], ["--idempotency-key", "x".repeat(256)]]) {
      const result = await runCli([
        "email",
        "domains",
        "rotate-dkim",
        receipt.domainId,
        ...keyArgs,
        "--json",
      ]);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
    }
    const result = await runCli([
      "email",
      "domains",
      "rotate-dkim",
      receipt.domainId,
      "--idempotency-key",
      "rotation-1",
      "--dry-run",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: {
        dryRun: true,
        action: "email.domains.rotate-dkim",
        id: receipt.domainId,
        idempotencyKey: "rotation-1",
      },
    });
  });

  it("posts only the scoped rotation with stable retry headers and preserves DNS retention guidance", async () => {
    const calls: Array<{
      method: string | undefined;
      url: string | undefined;
      key: unknown;
      auth: unknown;
    }> = [];
    const server = createServer((req, res) => {
      calls.push({
        method: req.method,
        url: req.url,
        key: req.headers["idempotency-key"],
        auth: req.headers["x-api-key"],
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(receipt));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const env = {
      SAMVA_API_KEY: "samva_sk_test_rotation",
      SAMVA_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    };
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await runCli(
          [
            "email",
            "domains",
            "rotate-dkim",
            receipt.domainId,
            "--idempotency-key",
            "rotation-1",
            "--json",
          ],
          { env },
        );
        expect(result.code, result.stderr).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toMatchObject({ data: receipt });
      }
      const human = await runCli(
        ["email", "domains", "rotate-dkim", receipt.domainId, "--idempotency-key", "rotation-1"],
        { env },
      );
      expect(human.code, human.stderr).toBe(0);
      expect(human.stdout).toContain(receipt.record.value);
      expect(human.stdout).toContain(receipt.formerRecord.value);
      expect(human.stdout).toContain("does not authorize deletion");
      expect(human.stdout).toContain("at least two actual former-record TTLs");
      expect(calls).toEqual(
        Array.from({ length: 3 }, () => ({
          method: "POST",
          url: `/v1/email/domains/${receipt.domainId}/rotate-dkim`,
          key: "rotation-1",
          auth: env.SAMVA_API_KEY,
        })),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("domain verification health output", () => {
  it("preserves structured health and explains customer action and freshness in human output", async () => {
    const api = await startDoctorApi({ domainPhase: "verifying" });
    try {
      const env = { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url };
      const args = ["email", "domains", "check", "dom_1234567890abcdefgh"];
      const json = await runCli([...args, "--json"], { env });
      expect(json.code, json.stderr).toBe(0);
      expect(JSON.parse(json.stdout)).toMatchObject({ data: verificationDetails });
      const human = await runCli(args, { env });
      expect(human.code, human.stderr).toBe(0);
      expect(human.stdout).toContain(verificationDetails.health.action);
      expect(human.stdout).toContain(verificationDetails.health.actionOwner);
      expect(human.stdout).toContain(verificationDetails.health.freshness);
      expect(human.stdout).toContain(verificationDetails.sending.reason);
      expect(human.stdout).toContain(verificationDetails.dmarc.guidance);
      // The provider setup stopped, and the customer has already asked for it
      // to start again twice; both facts are on the line, not just the phase.
      expect(human.stdout).toContain("Provider setup");
      expect(human.stdout).toContain("failed");
      expect(human.stdout).toContain("Setup attempt");
    } finally {
      await api.close();
    }
  });

  it("shows the certificate reason and check times in custom tracking status", async () => {
    const api = await startCustomTrackingApi();
    try {
      const result = await runCli(
        ["email", "domains", "custom-tracking", "status", trackingDomainId],
        {
          env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url },
        },
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Waiting for the validation record to appear.");
      expect(result.stdout).toContain("2026-10-10T12:00:00.000Z");
      expect(result.stdout).toContain("2026-10-10T12:00:20.000Z");
    } finally {
      await api.close();
    }
  });

  it("passes the custom tracking parent and label to the API and omits an unspecified parent", async () => {
    const api = await startCustomTrackingApi();
    try {
      const env = { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url };
      const args = ["email", "domains", "custom-tracking", "enable", trackingDomainId];
      const result = await runCli(
        [...args, "--parent", "example.com", "--label", "links", "--json"],
        { env },
      );
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({ data: customTrackingBody });
      expect(api.requests[0]).toMatchObject({
        method: "POST",
        path: `/v1/email/domains/${trackingDomainId}/custom-tracking`,
      });
      expect(JSON.parse(api.requests[0]!.body)).toEqual({
        label: "links",
        parentDomain: "example.com",
      });

      const defaultParent = await runCli([...args, "--json"], { env });
      expect(defaultParent.code, defaultParent.stderr).toBe(0);
      expect(JSON.parse(api.requests[1]!.body)).toEqual({});

      const preview = await runCli([...args, "--parent", "example.com", "--dry-run", "--json"], {
        env,
      });
      expect(preview.code, preview.stderr).toBe(0);
      expect(JSON.parse(preview.stdout)).toMatchObject({
        data: { dryRun: true, parentDomain: "example.com" },
      });
      expect(api.requests).toHaveLength(2);
    } finally {
      await api.close();
    }
  });

  it("rechecks custom tracking with a POST and prints the refreshed state", async () => {
    const api = await startCustomTrackingApi();
    try {
      const result = await runCli(
        ["email", "domains", "custom-tracking", "recheck", trackingDomainId, "--json"],
        { env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: api.url } },
      );
      expect(result.code).toBe(0);
      expect(api.requests[0]?.method).toBe("POST");
      expect(api.requests[0]?.path).toContain("/custom-tracking/recheck");
      expect(JSON.parse(result.stdout).data.customTracking.certificate.reason.code).toBe(
        "awaiting-dcv",
      );
    } finally {
      await api.close();
    }
  });
});
