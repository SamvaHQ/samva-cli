import { describe, expect, it } from "@effect/vitest";

import { classifyMessageLifecycle, waitingLine } from "../src/commands/messages";

const classify = (status: string, deliveries: ReadonlyArray<string> = []) =>
  classifyMessageLifecycle({
    status,
    deliveries: deliveries.map((deliveryStatus) => ({ status: deliveryStatus })),
  });

describe("message lifecycle classification", () => {
  it.each(["delivered", "read"])("treats %s as success", (status) => {
    expect(classify(status)).toBe("success");
  });

  it.each(["failed", "bounced", "complained"])("treats %s as failure", (status) => {
    expect(classify(status)).toBe("failure");
  });

  it("keeps sent and queued messages pending", () => {
    expect(classify("sent")).toBe("pending");
    expect(classify("queued", ["sent"])).toBe("pending");
  });

  it("lets any recipient failure override a successful recipient", () => {
    expect(classify("sent", ["delivered", "bounced"])).toBe("failure");
    expect(classify("delivered", ["delivered", "failed"])).toBe("failure");
  });

  it("does not finish while any recipient remains pending", () => {
    expect(classify("sent", ["delivered", "sent"])).toBe("pending");
  });
});

describe("message waiting line", () => {
  it("names a content review with the time Samva expects to decide it", () => {
    expect(
      waitingLine({ waitReason: "content-review", reviewExpectedAt: "2026-09-25T14:00:00.000Z" }),
    ).toBe("content review (expected by 2026-09-25T14:00:00.000Z)");
  });

  it("names any other wait without a time", () => {
    expect(waitingLine({ waitReason: "sending-paused", reviewExpectedAt: null })).toBe(
      "sending paused",
    );
  });

  it("is absent when nothing holds the message", () => {
    expect(waitingLine({ waitReason: null, reviewExpectedAt: null })).toBeNull();
  });
});
