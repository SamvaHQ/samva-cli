import { describe, expect, it } from "@effect/vitest";

import { whatsappSendError, whatsappTemplatesPath } from "../src/commands/whatsapp";

describe("whatsappTemplatesPath", () => {
  it("filters to the WhatsApp channel and carries paging", () => {
    expect(whatsappTemplatesPath(undefined, undefined)).toBe("/v1/templates?channel=whatsapp");
    expect(whatsappTemplatesPath(10, "abc")).toBe(
      "/v1/templates?channel=whatsapp&limit=10&cursor=abc",
    );
  });
});

describe("whatsappSendError", () => {
  it("points a refused free-form text at an approved template", () => {
    const error = whatsappSendError({
      _tag: "ValidationError",
      message: "The 24-hour customer service window is closed; use an approved template.",
    });
    expect(error.message).toBe(
      "The 24-hour customer service window is closed; use an approved template.",
    );
    expect(error.api?.reason).toBe("ValidationError");
    expect(error.api?.status).toBe(422);
    expect(error.api?.next).toContain("approved template");
    expect(error.api?.next).toContain("media");
  });

  it("names an unregistered business number", () => {
    const error = whatsappSendError({ _tag: "SenderNotReadyError", message: "Not ready." });
    expect(error.api?.status).toBe(503);
    expect(error.api?.next).toContain("Finish WhatsApp signup");
  });

  it("leaves other failures with the shared guidance", () => {
    const error = whatsappSendError({ _tag: "RateLimitedError", message: "Slow down." });
    expect(error.api?.next).toBe("Wait a moment before retrying.");
  });
});
