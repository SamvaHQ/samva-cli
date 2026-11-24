import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";

import { assembleScheduledEmailPayload } from "../src/commands/scheduled";
import { runCli } from "./support/run-cli";

describe("samva scheduled command helpers", () => {
  it("assembles an email schedule payload from resolved flags", () => {
    const payload = assembleScheduledEmailPayload({
      to: ["you@example.com"],
      subject: "Hi",
      html: undefined,
      text: "Hello",
      templateId: undefined,
      publicationId: undefined,
      inputContractId: undefined,
      templateSlug: undefined,
      templateData: undefined,
      cc: "boss@example.com",
      bcc: undefined,
      scheduledFor: "2026-08-01T09:00:00Z",
      timezone: "America/New_York",
      referenceId: "ref-1",
      tracking: { opens: false },
    });

    expect(payload).toMatchObject({
      send: {
        channel: "email",
        to: [{ email: "you@example.com" }],
        cc: [{ email: "boss@example.com" }],
        email: { subject: "Hi", text: "Hello", tracking: { opens: false } },
      },
      scheduledFor: "2026-08-01T09:00:00Z",
      timezone: "America/New_York",
      referenceId: "ref-1",
    });
  });

  it("carries the sender when given and leaves it out otherwise", () => {
    const input = {
      to: ["you@example.com"],
      subject: "Hi",
      html: "<p>Hi</p>",
      text: undefined,
      templateId: undefined,
      publicationId: undefined,
      inputContractId: undefined,
      templateSlug: undefined,
      templateData: undefined,
      cc: undefined,
      bcc: undefined,
      scheduledFor: new Date("2026-08-01T09:00:00Z"),
      timezone: undefined,
      referenceId: undefined,
      tracking: undefined,
    };
    const from = { email: "hello@acme.test", name: "Acme" };
    expect(assembleScheduledEmailPayload({ ...input, from }).send).toMatchObject({ from });
    expect(assembleScheduledEmailPayload(input).send).not.toHaveProperty("from");
  });

  it("carries a template reference and drops optional recipients when unset", () => {
    const payload = assembleScheduledEmailPayload({
      to: ["a@example.com", "b@example.com"],
      subject: "Welcome",
      html: undefined,
      text: undefined,
      templateId: undefined,
      publicationId: undefined,
      inputContractId: undefined,
      templateSlug: "welcome-email",
      templateData: { name: "Ada" },
      cc: undefined,
      bcc: undefined,
      scheduledFor: "2026-08-01T09:00:00Z",
      timezone: undefined,
      referenceId: undefined,
      tracking: undefined,
    });

    expect(payload.send.channel).toBe("email");
    expect(payload.send.to).toEqual([{ email: "a@example.com" }, { email: "b@example.com" }]);
    // Undefined optionals must serialize away rather than send null recipients.
    const serialized = JSON.parse(JSON.stringify(payload)) as { send: Record<string, unknown> };
    expect(serialized.send).not.toHaveProperty("cc");
    expect(serialized.send).not.toHaveProperty("bcc");
    expect(payload.send).toMatchObject({
      email: { subject: "Welcome", templateSlug: "welcome-email", templateData: { name: "Ada" } },
    });
  });
});

describe("samva scheduled-messages resume --dry-run", () => {
  const id = "sched_7q2xk9mvt4znw8rh";
  let configHome: string;
  beforeAll(async () => {
    configHome = await mkdtemp(join(tmpdir(), "samva-cli-resume-"));
  });
  afterAll(async () => {
    await rm(configHome, { recursive: true, force: true });
  });

  it("previews the resume without credentials or a request", async () => {
    const sendNow = await runCli(["scheduled-messages", "resume", id, "--send-now", "--dry-run"], {
      configHome,
    });
    expect(sendNow.code, sendNow.stderr).toBe(0);
    expect(sendNow.stdout).toBe(
      `[dry-run] Would resume scheduled message ${id} and send it now.\n`,
    );

    const later = await runCli(
      ["scheduled-messages", "resume", id, "--at", "2026-10-01T09:00:00Z", "--dry-run", "--json"],
      { configHome },
    );
    expect(later.code, later.stderr).toBe(0);
    expect(JSON.parse(later.stdout).data).toEqual({
      dryRun: true,
      action: "scheduled.resume",
      id,
      choice: "new_time",
      scheduledFor: "2026-10-01T09:00:00.000Z",
    });
  });

  it("still requires exactly one of --send-now or --at", async () => {
    const result = await runCli(["scheduled-messages", "resume", id, "--dry-run"], { configHome });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Choose exactly one of --send-now or --at.");
  });
});
