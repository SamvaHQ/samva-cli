import { describe, expect, it } from "@effect/vitest";

import { assembleScheduledEmailPayload } from "../src/commands/scheduled";

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
      idempotencyKey: "key-1",
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
      idempotencyKey: "key-1",
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
      idempotencyKey: undefined,
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
      idempotencyKey: undefined,
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
