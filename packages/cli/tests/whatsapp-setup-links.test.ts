import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FlagDisabledError } from "samva/effect";

import {
  createSetupLinkPayload,
  listSetupLinksPath,
  parseMetadataPairs,
  setupLinkError,
  setupLinkFields,
  setupLinksPath,
  type WireSetupLink,
} from "../src/commands/whatsapp-setup-links";

const link = (overrides: Partial<WireSetupLink> = {}): WireSetupLink => ({
  id: "wasl_2eqcmea000000000",
  organizationId: "org_2eqcmea000000000",
  namespaceId: "ns_2eqcmea000000000",
  status: "pending",
  redirectUrl: null,
  metadata: { customer: "acme" },
  expiresAt: "2026-10-24T00:00:00.000Z",
  businessAccountId: null,
  completedAt: null,
  revokedAt: null,
  createdAt: "2026-10-17T00:00:00.000Z",
  updatedAt: "2026-10-17T00:00:00.000Z",
  ...overrides,
});

describe("setupLinksPath", () => {
  it("addresses the collection, one link, and its revoke action", () => {
    expect(setupLinksPath()).toBe("/v1/whatsapp/setup-links");
    expect(setupLinksPath("wasl_a")).toBe("/v1/whatsapp/setup-links/wasl_a");
    expect(setupLinksPath("wasl_a", "revoke")).toBe("/v1/whatsapp/setup-links/wasl_a/revoke");
  });

  it("carries only the filters given", () => {
    expect(listSetupLinksPath({})).toBe("/v1/whatsapp/setup-links");
    expect(
      listSetupLinksPath({ namespaceId: "ns_a", status: "pending", limit: 5, cursor: "c" }),
    ).toBe("/v1/whatsapp/setup-links?namespaceId=ns_a&status=pending&limit=5&cursor=c");
  });
});

describe("createSetupLinkPayload", () => {
  it("names the namespace alone by default", () => {
    expect(createSetupLinkPayload({ namespaceId: "ns_a", metadata: {} })).toEqual({
      namespaceId: "ns_a",
    });
  });

  it("carries each optional field when given", () => {
    expect(
      createSetupLinkPayload({
        namespaceId: "ns_a",
        redirectUrl: "https://example.com/done",
        metadata: { customer: "acme" },
        expiresAt: "2026-11-01T00:00:00Z",
      }),
    ).toEqual({
      namespaceId: "ns_a",
      redirectUrl: "https://example.com/done",
      metadata: { customer: "acme" },
      expiresAt: "2026-11-01T00:00:00Z",
    });
  });
});

describe("parseMetadataPairs", () => {
  it.effect("splits on the first equals sign", () =>
    Effect.gen(function* () {
      expect(yield* parseMetadataPairs(["a=b=c", "k="])).toEqual({ a: "b=c", k: "" });
    }),
  );

  it.effect("refuses a pair without a key", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(parseMetadataPairs(["=x"]));
      expect(error.message).toContain("key=value");
    }),
  );
});

describe("setupLinkFields", () => {
  it("lists the link and each metadata entry", () => {
    const fields = setupLinkFields(link());
    expect(fields).toContainEqual(["Status", "pending"]);
    expect(fields).toContainEqual(["Metadata customer", "acme"]);
  });
});

describe("setupLinkError", () => {
  it("explains a link that can no longer be revoked", () => {
    const error = setupLinkError("revoke the setup link")({
      _tag: "WhatsAppSetupLinkUnavailableError",
      reason: "completed",
      message: "This setup link already connected a WhatsApp number.",
    });
    expect(error.api?.status).toBe(410);
    expect(error.api?.next).toContain("pending");
  });

  it("names a disabled channel", () => {
    const error = setupLinkError("list setup links")(
      new FlagDisabledError({ flag: "whatsapp", message: "Feature 'whatsapp' is not enabled." }),
    );
    expect(error.api?.next).toBe("WhatsApp is not enabled for this organization.");
  });
});
