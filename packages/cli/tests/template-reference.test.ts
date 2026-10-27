import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { assembleCampaignCreatePayload } from "../src/commands/campaigns";
import { assembleScheduledEmailPayload } from "../src/commands/scheduled";
import { resolveTemplateReference } from "../src/lib/template-reference";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(Effect.result(effect));

describe("template reference flags", () => {
  it("carries exactly the reference the caller named", () => {
    expect(
      run(
        resolveTemplateReference({
          templateId: "tmpl_2eqcmea000000000",
          publicationId: "tpub_2eqcmea000000000",
          inputContractId: undefined,
        }),
      ),
    ).toMatchObject({ success: { publicationId: "tpub_2eqcmea000000000" } });
    expect(
      run(
        resolveTemplateReference({
          templateId: "tmpl_2eqcmea000000000",
          publicationId: undefined,
          inputContractId: "tcon_2eqcmea000000000",
        }),
      ),
    ).toMatchObject({ success: { inputContractId: "tcon_2eqcmea000000000" } });
    // No reference is the default: the template's current publication renders.
    expect(
      run(
        resolveTemplateReference({
          templateId: "tmpl_2eqcmea000000000",
          publicationId: undefined,
          inputContractId: undefined,
        }),
      ),
    ).toMatchObject({ success: {} });
  });

  it("refuses both references at once, the way the API does", () => {
    const result = run(
      resolveTemplateReference({
        templateId: "tmpl_2eqcmea000000000",
        publicationId: "tpub_2eqcmea000000000",
        inputContractId: "tcon_2eqcmea000000000",
      }),
    );
    expect(result).toMatchObject({
      failure: { message: expect.stringContaining("not both") },
    });
  });

  it("refuses a reference with no template to reference", () => {
    for (const reference of [
      { publicationId: "tpub_2eqcmea000000000", inputContractId: undefined },
      { publicationId: undefined, inputContractId: "tcon_2eqcmea000000000" },
    ]) {
      expect(run(resolveTemplateReference({ templateId: undefined, ...reference }))).toMatchObject({
        failure: { message: expect.stringContaining("need --template-id") },
      });
    }
  });
});

describe("send payloads carry the reference", () => {
  it("pins a scheduled message to one exact publication", () => {
    const payload = assembleScheduledEmailPayload({
      to: ["you@example.com"],
      subject: undefined,
      html: undefined,
      text: undefined,
      templateId: "tmpl_2eqcmea000000000",
      publicationId: "tpub_2eqcmea000000000",
      inputContractId: undefined,
      templateSlug: undefined,
      templateData: { name: "Ada" },
      cc: undefined,
      bcc: undefined,
      scheduledFor: "2026-09-08T09:00:00Z",
      timezone: undefined,
      idempotencyKey: undefined,
      referenceId: undefined,
      tracking: undefined,
    });
    expect(payload.send.email).toMatchObject({
      templateId: "tmpl_2eqcmea000000000",
      publicationId: "tpub_2eqcmea000000000",
    });
    expect(JSON.parse(JSON.stringify(payload.send.email))).not.toHaveProperty("inputContractId");
  });

  it("adopts an input contract for a campaign", () => {
    const payload = assembleCampaignCreatePayload({
      name: "Weekly digest",
      subject: undefined,
      html: undefined,
      text: undefined,
      templateId: "tmpl_3rgest0000000000",
      publicationId: undefined,
      inputContractId: "tcon_3rgest0000000000",
      templateSlug: undefined,
      templateData: { items: [] },
      includeTags: ["subscribers"],
      excludeTags: [],
      contactIds: [],
      topicId: "unsub_1234567890abcdef",
      pageSize: undefined,
      tracking: undefined,
    });
    expect(payload.content).toMatchObject({
      channel: "email",
      email: {
        templateId: "tmpl_3rgest0000000000",
        inputContractId: "tcon_3rgest0000000000",
      },
    });
    expect(
      JSON.parse(JSON.stringify((payload.content as { email: unknown }).email)),
    ).not.toHaveProperty("publicationId");
  });
});
