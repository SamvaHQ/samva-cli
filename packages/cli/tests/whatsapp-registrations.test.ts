import { describe, expect, it } from "@effect/vitest";
import { FlagDisabledError } from "samva/effect";

import {
  registrationError,
  registrationFields,
  registrationsPath,
  registrationSummary,
  submitRegistrationPayload,
  type WireRegistration,
} from "../src/commands/whatsapp-registrations";

const registration = (overrides: Partial<WireRegistration> = {}): WireRegistration => ({
  id: "treg_2eqcmea000000000",
  templateId: "tmpl_2eqcmea000000000",
  publicationId: "tpub_2eqcmea000000000",
  target: { provider: "whatsapp", wabaId: "1234567890" },
  name: "order_shipped",
  language: "en_US",
  status: "submitted",
  category: "utility",
  providerCategory: null,
  providerTemplateId: null,
  reason: null,
  submittedAt: "2026-10-13T00:00:00.000Z",
  statusChangedAt: "2026-10-13T00:00:00.000Z",
  createdAt: "2026-10-13T00:00:00.000Z",
  updatedAt: "2026-10-13T00:00:00.000Z",
  ...overrides,
});

describe("registrationsPath", () => {
  it("addresses the collection and one registration", () => {
    expect(registrationsPath("tmpl_a")).toBe("/v1/templates/tmpl_a/registrations");
    expect(registrationsPath("tmpl_a", "treg_b")).toBe("/v1/templates/tmpl_a/registrations/treg_b");
  });
});

describe("submitRegistrationPayload", () => {
  it("names WhatsApp and the business account only when given", () => {
    expect(submitRegistrationPayload(undefined)).toEqual({ provider: "whatsapp" });
    expect(submitRegistrationPayload("waba_x")).toEqual({
      provider: "whatsapp",
      businessAccountId: "waba_x",
    });
  });
});

describe("registrationFields", () => {
  it("leads with identity and status and carries Meta's reason", () => {
    const fields = registrationFields(registration({ status: "rejected", reason: "Bad variable" }));
    expect(fields.slice(0, 4).map(([label]) => label)).toEqual([
      "Registration ID",
      "Template ID",
      "Publication ID",
      "Status",
    ]);
    expect(fields).toContainEqual(["Reason", "Bad variable"]);
    expect(fields).toContainEqual(["Business account", "1234567890"]);
  });
});

describe("registrationSummary", () => {
  it("says when nothing was submitted", () => {
    expect(registrationSummary([])).toBe("not submitted");
  });

  it("names each status with its reason", () => {
    expect(
      registrationSummary([
        registration({ status: "approved" }),
        registration({ status: "rejected", reason: "Bad variable" }),
      ]),
    ).toBe("approved; rejected (Bad variable)");
  });
});

describe("registrationError", () => {
  it("keeps Meta's reason and names the recovery step", () => {
    const error = registrationError("submit the template registration")({
      _tag: "ValidationError",
      message: "Meta refused the template: body has too many variables.",
    });
    expect(error.message).toBe("Meta refused the template: body has too many variables.");
    expect(error.api?.next).toContain("Meta's reason");
  });

  it("explains an unpublished or in-review template", () => {
    const error = registrationError("submit the template registration")({
      _tag: "ConflictError",
      message: "The template is not published.",
    });
    expect(error.api?.status).toBe(409);
    expect(error.api?.next).toContain("samva templates publish");
  });

  it("names a disabled channel", () => {
    const error = registrationError("list template registrations")(
      new FlagDisabledError({ flag: "whatsapp", message: "Feature 'whatsapp' is not enabled." }),
    );
    expect(error.api?.next).toBe("WhatsApp is not enabled for this organization.");
  });
});
