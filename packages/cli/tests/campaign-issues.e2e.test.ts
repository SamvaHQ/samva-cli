import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { runCli } from "./support/run-cli";

const TOPIC = "unsub_1234567890abcdef";
const CAMPAIGN = "camp_1234567890abcdef";
const issue = { path: "issues/october.md", commit: "a".repeat(40) };
const content = { channel: "email", issue, email: {} };
const AT = "2026-10-26T00:00:00Z";
const campaign = {
  id: CAMPAIGN,
  name: "October",
  channel: "email",
  content,
  audience: { topicId: TOPIC },
  policy: {},
  definition: { state: "editable", frozenAt: null },
  latestRun: null,
  createdBy: null,
  actorEmail: "owner@example.com",
  memberRole: "owner",
  createdAt: AT,
  updatedAt: AT,
};
let configHome: string;
beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), "samva-campaign-issues-"));
});
afterEach(async () => {
  await rm(configHome, { recursive: true, force: true });
});
const startApi = async () => {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const path = req.url ?? "/";
    requests.push({ method: req.method ?? "GET", path, body: body ? JSON.parse(body) : null });
    let response: unknown = campaign;
    if (path.endsWith("/preview"))
      response = {
        subject: "October",
        preheader: "News",
        html: "<h1>October</h1>",
        text: "October",
      };
    else if (path.endsWith("/test-send")) response = { id: "msg_1234567890abcdef" };
    else if (path.endsWith("/runs"))
      response = {
        id: "crun_1234567890abcdef",
        campaignId: CAMPAIGN,
        status: "scheduled",
        scheduledFor: AT,
        startedAt: null,
        completedAt: null,
        contentSnapshot: content,
        audienceSnapshot: campaign.audience,
        policySnapshot: {},
        totalRecipients: 0,
        dispatchedCount: 0,
        failedCount: 0,
        skippedCount: 0,
        skippedReasons: [],
        estimatedCompletionAt: null,
        failureReason: null,
        pendingCount: 0,
        holdReason: null,
        holdDomainId: null,
        holdUntil: null,
        capacityWarning: null,
        lastContactId: null,
        idempotencyKey: "run-1",
        createdBy: null,
        actorEmail: "owner@example.com",
        memberRole: "owner",
        createdAt: AT,
        updatedAt: AT,
      };
    res.writeHead(
      req.method === "POST" && (path === "/v1/campaigns" || path.endsWith("/runs")) ? 201 : 200,
      {
        "content-type": "application/json",
      },
    );
    res.end(JSON.stringify(response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Test API did not bind");
  return {
    requests,
    env: {
      SAMVA_API_KEY: "samva_sk_test_issue_campaign",
      SAMVA_API_URL: `http://127.0.0.1:${address.port}`,
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
const pinFlags = ["--issue-path", issue.path, "--issue-commit", issue.commit];

describe("pinned issue campaign CLI", () => {
  it("formats previews and test receipts for people while preserving dry-run inspection", async () => {
    const api = await startApi();
    try {
      const preview = await runCli(["campaigns", "preview", "--topic-id", TOPIC, ...pinFlags], {
        configHome,
        env: api.env,
      });
      expect(preview.code, preview.stderr).toBe(0);
      expect(preview.stdout).toContain("Subject");
      expect(preview.stdout).toContain("October");
      expect(preview.stdout.trimStart().startsWith("{")).toBe(false);
      const sent = await runCli(["campaigns", "test", "--topic-id", TOPIC, ...pinFlags], {
        configHome,
        env: api.env,
      });
      expect(sent.code, sent.stderr).toBe(0);
      expect(sent.stdout).toContain("Message ID");
      expect(sent.stdout).toContain("samva messages get msg_1234567890abcdef");
      const dry = await runCli(
        ["campaigns", "test", "--topic-id", TOPIC, ...pinFlags, "--dry-run"],
        { configHome, env: api.env },
      );
      expect(dry.code, dry.stderr).toBe(0);
      expect(dry.stdout).toContain(issue.path);
      expect(api.requests).toHaveLength(2);
    } finally {
      await api.close();
    }
  }, 30_000);

  it("creates, updates, previews, tests and schedules a saved issue pin through the existing API", async () => {
    const api = await startApi();
    try {
      for (const args of [
        ["create", "--name", "October", "--topic-id", TOPIC, ...pinFlags],
        ["update", CAMPAIGN, ...pinFlags],
        ["preview", "--topic-id", TOPIC, ...pinFlags],
        ["test", "--topic-id", TOPIC, "--contact-id", "contact_1234567890abcdef", ...pinFlags],
        ["runs", "create", CAMPAIGN, "--at", AT, "--idempotency-key", "run-1"],
      ]) {
        const result = await runCli(["campaigns", ...args, "--json"], { configHome, env: api.env });
        expect(result.code, result.stderr).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, type: "result" });
      }
      expect(api.requests).toEqual([
        {
          method: "POST",
          path: "/v1/campaigns",
          body: { name: "October", channel: "email", content, audience: { topicId: TOPIC } },
        },
        { method: "PATCH", path: `/v1/campaigns/${CAMPAIGN}`, body: { content } },
        {
          method: "POST",
          path: "/v1/campaigns/preview",
          body: { content, audience: { topicId: TOPIC } },
        },
        {
          method: "POST",
          path: "/v1/campaigns/test-send",
          body: { content, audience: { topicId: TOPIC }, contactId: "contact_1234567890abcdef" },
        },
        {
          method: "POST",
          path: `/v1/campaigns/${CAMPAIGN}/runs`,
          body: { scheduledFor: "2026-10-26T00:00:00.000Z", idempotencyKey: "run-1" },
        },
      ]);
    } finally {
      await api.close();
    }
  }, 30000);

  it("previews issue requests without API calls and preserves templateData fallbacks", async () => {
    const api = await startApi();
    try {
      for (const name of ["create", "preview", "test"]) {
        const args = name === "create" ? ["--name", "October"] : [];
        const result = await runCli(
          [
            "campaigns",
            name,
            ...args,
            "--topic-id",
            TOPIC,
            ...pinFlags,
            "--template-data",
            '{"firstName":"Reader"}',
            "--dry-run",
            "--json",
          ],
          { configHome, env: api.env },
        );
        expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).data.request.content).toEqual({
          ...content,
          email: { templateData: { firstName: "Reader" } },
        });
      }
      expect(api.requests).toEqual([]);
    } finally {
      await api.close();
    }
  });

  it.each(["create", "update", "preview", "test"])(
    "%s rejects incomplete pins and mixed inline/template content before the API",
    async (name) => {
      const api = await startApi();
      try {
        const invalid = [
          ["--issue-path", issue.path],
          ["--issue-commit", issue.commit],
          ["--issue-path", "../outside.md", "--issue-commit", issue.commit],
          ["--issue-path", issue.path, "--issue-commit", "main"],
          ...[
            "--subject",
            "--preheader",
            "--html",
            "--text",
            "--template-id",
            "--template-slug",
            "--publication-id",
            "--input-contract-id",
          ].map((flag) => [...pinFlags, flag, ""]),
        ];
        const args =
          name === "create"
            ? ["--name", "October", "--topic-id", TOPIC]
            : name === "update"
              ? [CAMPAIGN]
              : ["--topic-id", TOPIC];
        for (const flags of invalid) {
          const result = await runCli(["campaigns", name, ...args, ...flags, "--json"], {
            configHome,
            env: api.env,
          });
          expect(result.code, `${name} ${flags.join(" ")}\n${result.stderr}`).toBe(2);
          expect(result.stdout).toBe("");
          expect(JSON.parse(result.stderr).reason).toMatch(/issue/);
        }
        expect(api.requests).toEqual([]);
      } finally {
        await api.close();
      }
    },
    60000,
  );
});
