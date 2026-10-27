import { describe, expect, it } from "@effect/vitest";

import { assembleCampaignCreatePayload, parseTagList } from "../src/commands/campaigns";

describe("parseTagList", () => {
  it("flattens comma-separated and repeated values, trimming and dropping blanks", () => {
    expect(parseTagList(["newsletter,customers", "vip", " spaced , ", ""])).toEqual([
      "newsletter",
      "customers",
      "vip",
      "spaced",
    ]);
  });
});

describe("assembleCampaignCreatePayload", () => {
  it("builds an email campaign with tag audience and a policy", () => {
    const payload = assembleCampaignCreatePayload({
      name: "Spring launch",
      subject: "We are live",
      html: "<h1>Hi</h1>",
      text: undefined,
      templateId: undefined,
      publicationId: undefined,
      inputContractId: undefined,
      templateSlug: undefined,
      templateData: undefined,
      includeTags: ["newsletter", "customers"],
      excludeTags: ["churned"],
      contactIds: [],
      topicId: "grp-1",
      pageSize: 200,
      tracking: { opens: false, clicks: true },
    });

    expect(payload).toMatchObject({
      name: "Spring launch",
      channel: "email",
      content: {
        channel: "email",
        email: {
          subject: "We are live",
          html: "<h1>Hi</h1>",
          tracking: { opens: false, clicks: true },
        },
      },
      audience: {
        topicId: "grp-1",
        includeTags: ["newsletter", "customers"],
        excludeTags: ["churned"],
      },
      policy: { pageSize: 200 },
    });
    // Empty audience arrays collapse to undefined, not [].
    const serialized = JSON.parse(JSON.stringify(payload)) as {
      audience: Record<string, unknown>;
    };
    expect(serialized.audience).not.toHaveProperty("contactIds");
  });

  it("omits policy entirely when neither policy flag is set", () => {
    const payload = assembleCampaignCreatePayload({
      name: "VIP note",
      subject: undefined,
      html: undefined,
      text: "Hello",
      templateId: undefined,
      publicationId: undefined,
      inputContractId: undefined,
      templateSlug: undefined,
      templateData: undefined,
      includeTags: [],
      excludeTags: [],
      contactIds: ["c_1", "c_2"],
      topicId: "unsub_1234567890abcdef",
      pageSize: undefined,
      tracking: undefined,
    });

    expect(payload.policy).toBeUndefined();
    expect(payload.audience).toMatchObject({ contactIds: ["c_1", "c_2"] });
    expect(payload.content).toMatchObject({ channel: "email", email: { text: "Hello" } });
  });
});
