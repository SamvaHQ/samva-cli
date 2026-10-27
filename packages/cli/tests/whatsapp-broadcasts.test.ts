import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  parseBindings,
  parseLiteralData,
  skippedLine,
  sourceLabel,
  templateStatsPath,
  whatsappBroadcastPayload,
} from "../src/commands/whatsapp-broadcasts";

describe("parseBindings", () => {
  it.effect("reads contact fields and custom fields", () =>
    Effect.gen(function* () {
      expect(
        yield* parseBindings(["name=contact.firstName", "plan=customField.plan.tier"]),
      ).toEqual({ name: { contact: "firstName" }, plan: { customField: "plan.tier" } });
    }),
  );

  it.effect("refuses an unknown field, a bare source, and a repeated parameter", () =>
    Effect.gen(function* () {
      for (const entries of [
        ["name=contact.nickname"],
        ["name=firstName"],
        ["name"],
        ["name=customField."],
        ["a=contact.id", "a=contact.name"],
      ]) {
        expect(Exit.isFailure(yield* Effect.exit(parseBindings(entries)))).toBe(true);
      }
    }),
  );
});

describe("parseLiteralData", () => {
  it.effect("keeps everything after the first equals sign", () =>
    Effect.gen(function* () {
      expect(yield* parseLiteralData(["offer=A=B", "code=SAVE10"])).toEqual({
        offer: "A=B",
        code: "SAVE10",
      });
    }),
  );

  it.effect("refuses a repeated parameter and an empty value", () =>
    Effect.gen(function* () {
      expect(Exit.isFailure(yield* Effect.exit(parseLiteralData(["a=1", "a=2"])))).toBe(true);
      expect(Exit.isFailure(yield* Effect.exit(parseLiteralData(["a="])))).toBe(true);
    }),
  );
});

describe("whatsappBroadcastPayload", () => {
  const base = {
    name: "Restock",
    template: "restock",
    data: {},
    bindings: {},
    businessAccountId: undefined,
    includeTags: [],
    excludeTags: [],
    groupIds: [],
    contactIds: [],
  };

  it("carries the template, bindings, data, and sending account", () => {
    const payload = whatsappBroadcastPayload({
      ...base,
      data: { offer: "SAVE10" },
      bindings: { name: { contact: "firstName" } },
      businessAccountId: "waba_1",
      includeTags: ["customers"],
      groupIds: ["cgrp_1"],
    });
    expect(payload).toEqual({
      name: "Restock",
      channel: "whatsapp",
      content: {
        channel: "whatsapp",
        whatsapp: {
          template: "restock",
          templateData: { offer: "SAVE10" },
          bindings: { name: { contact: "firstName" } },
          businessAccountId: "waba_1",
        },
      },
      audience: {
        includeTags: ["customers"],
        excludeTags: undefined,
        groupIds: ["cgrp_1"],
        contactIds: undefined,
      },
    });
  });

  it("omits what was not given", () => {
    expect(whatsappBroadcastPayload(base).content.whatsapp).toEqual({ template: "restock" });
  });
});

describe("templateStatsPath", () => {
  it("is bare without filters and encodes the ones given", () => {
    expect(templateStatsPath({})).toBe("/v1/whatsapp/templates/stats");
    expect(templateStatsPath({ campaignId: "camp_1", startDate: "2026-08-01" })).toBe(
      "/v1/whatsapp/templates/stats?startDate=2026-08-01&campaignId=camp_1",
    );
  });
});

describe("labels", () => {
  it("names each stats source", () => {
    expect(sourceLabel({ type: "direct" })).toBe("direct");
    expect(sourceLabel({ type: "campaign", campaignId: "camp_1" })).toBe("campaign camp_1");
    expect(sourceLabel({ type: "journey", journeyId: "jrny_1", nodeId: "n1" })).toBe(
      "journey jrny_1 / n1",
    );
  });

  it("lists skipped reasons", () => {
    expect(
      skippedLine([
        { reason: "opted_out", count: 3 },
        { reason: "unreachable", count: 1 },
      ]),
    ).toBe("opted_out 3, unreachable 1");
  });
});
