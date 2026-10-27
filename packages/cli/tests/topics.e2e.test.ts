import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { runCli } from "./support/run-cli";

const ID = "unsub_1234567890abcdef";
const topic = {
  id: ID,
  namespaceId: null,
  name: "Newsletter",
  description: null,
  default: "opt_in",
  isDefault: false,
  defaultSenderId: null,
  replyMailboxId: null,
  templateId: null,
  archiveEnabled: false,
  publicationSlug: null,
  subscriptions: {
    email: { subscribed: 7, unsubscribed: 2 },
    sms: { subscribed: 0, unsubscribed: 0 },
    whatsapp: { subscribed: 0, unsubscribed: 0 },
  },
  createdAt: "2026-10-25T00:00:00Z",
  updatedAt: "2026-10-25T00:00:00Z",
};
let configHome: string;
beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), "samva-topics-"));
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
    let response: unknown = topic;
    if (path.startsWith("/v1/topics/check"))
      response = {
        contactId: null,
        channel: "email",
        topics: [{ topicId: ID, topicName: "Newsletter", status: "unsubscribed" }],
      };
    else if (path.includes("/subscriptions"))
      response = req.method === "POST" ? { updated: 1 } : { items: [], nextCursor: null };
    else if (req.method === "DELETE") response = { success: true };
    else if (path === "/v1/topics" || path.startsWith("/v1/topics?"))
      response = req.method === "GET" ? { items: [topic] } : topic;
    res.writeHead(req.method === "POST" && path === "/v1/topics" ? 201 : 200, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify(response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Test server did not bind TCP");
  return {
    requests,
    env: { SAMVA_API_KEY: "samva_sk_test_x", SAMVA_API_URL: `http://127.0.0.1:${address.port}` },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

describe("topics subprocess contract", () => {
  it("executes management commands with JSON-only output and exact API requests", async () => {
    const api = await startApi();
    try {
      const commands = [
        ["list", "--namespace-id", "ns_1234567890abcdef"],
        ["get", ID],
        ["create", "--name", "Newsletter", "--default", "opt_in"],
        ["update", ID, "--reply-mailbox-id", "none"],
        ["default", ID],
        ["remove", ID, "--yes"],
      ];
      for (const args of commands) {
        const result = await runCli(["topics", ...args, "--json"], { configHome, env: api.env });
        expect(result.code, result.stderr).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toMatchObject({
          schemaVersion: 1,
          type: "result",
          command: `topics.${args[0]}`,
        });
        if (args[0] === "list") {
          expect(JSON.parse(result.stdout).data.items[0].subscriptions.email).toEqual(
            topic.subscriptions.email,
          );
        } else if (args[0] !== "remove") {
          expect(JSON.parse(result.stdout).data.subscriptions.email).toEqual(
            topic.subscriptions.email,
          );
        }
      }
      expect(api.requests).toEqual([
        { method: "GET", path: "/v1/topics?namespaceId=ns_1234567890abcdef", body: null },
        { method: "GET", path: `/v1/topics/${ID}`, body: null },
        { method: "POST", path: "/v1/topics", body: { name: "Newsletter", default: "opt_in" } },
        { method: "PATCH", path: `/v1/topics/${ID}`, body: { replyMailboxId: null } },
        { method: "POST", path: `/v1/topics/${ID}/default`, body: null },
        { method: "DELETE", path: `/v1/topics/${ID}`, body: null },
      ]);
      const human = await runCli(["topics", "get", ID], { configHome, env: api.env });
      expect(human.code).toBe(0);
      expect(human.stdout).toContain("Newsletter");
      expect(human.stdout).toContain("opt_in");
      expect(human.stdout).not.toContain("\u001b[");
    } finally {
      await api.close();
    }
  });

  it("propagates hosted publication settings in create and update requests", async () => {
    const api = await startApi();
    try {
      for (const args of [
        [
          "create",
          "--name",
          "Newsletter",
          "--default",
          "opt_in",
          "--archive",
          "enabled",
          "--publication-slug",
          "news",
        ],
        ["update", ID, "--archive", "disabled", "--publication-slug", "none"],
      ]) {
        const result = await runCli(["topics", ...args, "--json"], { configHome, env: api.env });
        expect(result.code, result.stderr).toBe(0);
      }
      expect(api.requests.map((request) => request.body)).toEqual([
        { name: "Newsletter", default: "opt_in", archiveEnabled: true, publicationSlug: "news" },
        { archiveEnabled: false, publicationSlug: null },
      ]);
    } finally {
      await api.close();
    }
  });

  it("writes both statuses and reads bounded explicit and effective preferences", async () => {
    const api = await startApi();
    try {
      for (const status of ["subscribed", "unsubscribed"]) {
        const result = await runCli(
          [
            "topics",
            "subscriptions",
            "set",
            ID,
            "--email",
            "ada@example.com",
            "--channel",
            "email",
            "--status",
            status,
            "--source",
            "import",
            "--json",
          ],
          { configHome, env: api.env },
        );
        expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).data).toEqual({ updated: 1 });
      }
      const listed = await runCli(
        [
          "topics",
          "subscriptions",
          "list",
          ID,
          "--limit",
          "2",
          "--status",
          "unsubscribed",
          "--json",
        ],
        { configHome, env: api.env },
      );
      expect(listed.code, listed.stderr).toBe(0);
      expect(JSON.parse(listed.stdout).data).toEqual({ items: [], nextCursor: null });
      const checked = await runCli(
        [
          "topics",
          "subscriptions",
          "check",
          "--email",
          "new@example.com",
          "--channel",
          "email",
          "--topic-id",
          ID,
          "--json",
        ],
        { configHome, env: api.env },
      );
      expect(checked.code, checked.stderr).toBe(0);
      expect(JSON.parse(checked.stdout).data).toMatchObject({
        contactId: null,
        channel: "email",
        topics: [{ topicId: ID, status: "unsubscribed" }],
      });
      expect(api.requests.slice(0, 2)).toEqual(
        ["subscribed", "unsubscribed"].map((status) => ({
          method: "POST",
          path: `/v1/topics/${ID}/subscriptions`,
          body: {
            contacts: [{ email: "ada@example.com" }],
            channel: "email",
            status,
            source: "import",
          },
        })),
      );
      expect(api.requests[2]?.path).toBe(
        `/v1/topics/${ID}/subscriptions?limit=2&status=unsubscribed`,
      );
      expect(api.requests[3]?.path).toContain(
        `/v1/topics/check?email=new%40example.com&channel=email&topicIds=${ID}`,
      );
    } finally {
      await api.close();
    }
  });

  it("previews without requests, gates removal, and rejects ambiguous identifiers and removed flags", async () => {
    const api = await startApi();
    try {
      const preview = await runCli(
        [
          "topics",
          "subscriptions",
          "set",
          ID,
          "--email",
          "ada@example.com",
          "--channel",
          "email",
          "--status",
          "subscribed",
          "--dry-run",
          "--json",
        ],
        { configHome, env: api.env },
      );
      expect(preview.code, preview.stderr).toBe(0);
      expect(JSON.parse(preview.stdout).data).toMatchObject({
        dryRun: true,
        action: "topics.setSubscriptions",
      });
      for (const args of [
        ["topics", "remove", ID],
        [
          "topics",
          "subscriptions",
          "check",
          "--email",
          "ada@example.com",
          "--phone",
          "+15555550100",
          "--channel",
          "email",
        ],
        ["topics", "subscriptions", "set", ID, "--channel", "email", "--status", "subscribed"],
        ["subscriptions", "subscribe", "--email", "ada@example.com", "--from", "news@example.com"],
        [
          "subscriptions",
          "subscribe",
          "--topic-id",
          ID,
          "--email",
          "ada@example.com",
          "--from",
          "news@example.com",
          "--contact-group-id",
          "cgrp_1234567890abcdef",
        ],
      ]) {
        const rejected = await runCli([...args, "--json"], { configHome, env: api.env });
        expect(rejected.code, rejected.stderr).toBe(2);
        expect(rejected.stdout).toBe("");
      }
      expect(api.requests).toEqual([]);
    } finally {
      await api.close();
    }
  });

  it("places the required campaign topic in its audience and the optional email topic in send input", async () => {
    const env = { SAMVA_API_KEY: "samva_sk_test_x" };
    const campaign = await runCli(
      [
        "campaigns",
        "create",
        "--topic-id",
        ID,
        "--name",
        "Newsletter",
        "--subject",
        "Hi",
        "--html",
        "<p>Hi</p>",
        "--dry-run",
        "--json",
      ],
      { configHome, env },
    );
    expect(campaign.code, campaign.stderr).toBe(0);
    const data = JSON.parse(campaign.stdout).data;
    expect(data.request.audience).toEqual({ topicId: ID });
    expect(data.request.policy).toBeUndefined();
    const email = await runCli(
      [
        "email",
        "send",
        "--to",
        "ada@example.com",
        "--subject",
        "Hi",
        "--text",
        "Hi",
        "--topic-id",
        ID,
        "--dry-run",
        "--json",
      ],
      { configHome, env },
    );
    expect(email.code, email.stderr).toBe(0);
    expect(JSON.parse(email.stdout).data.request.topicId).toBe(ID);
  });
});
