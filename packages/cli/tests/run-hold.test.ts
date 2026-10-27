import { describe, expect, it } from "@effect/vitest";

import { campaignPacingFields, holdFields, holdLabel } from "../src/lib/run-hold";

const rows = (fields: ReadonlyArray<readonly [string, unknown]>) =>
  Object.fromEntries(fields.filter(([, value]) => value !== null && value !== undefined));

describe("run holds", () => {
  it("names the messaging-limit hold and passes any other reason through", () => {
    expect(holdLabel("whatsapp_messaging_limit")).toContain("sooner if Meta raises the limit");
    expect(holdLabel("onboarding_review:new_sender")).toBe("onboarding_review:new_sender");
    expect(holdLabel(null)).toBeNull();
  });

  it("shows a held campaign run's reason, waiting count, resume time, and forecast", () => {
    expect(
      rows(
        campaignPacingFields(
          {
            holdReason: "whatsapp_messaging_limit",
            holdUntil: "2026-10-19T08:00:00.000Z",
            pendingCount: 1500,
            estimatedCompletionAt: "2026-10-19T09:00:00.000Z",
            capacityWarning: null,
          },
          { warning: true },
        ),
      ),
    ).toEqual({
      Held: holdLabel("whatsapp_messaging_limit"),
      "Resumes by": "2026-10-19T08:00:00.000Z",
      Pending: "1500",
      "Est. completion": "2026-10-19T09:00:00.000Z",
    });
  });

  it("shows the capacity warning only where asked, and no pending row for a settled run", () => {
    const run = { pendingCount: 0, capacityWarning: "Audience exceeds the limit." };
    expect(rows(campaignPacingFields(run, { warning: true }))).toEqual({
      "Capacity warning": "Audience exceeds the limit.",
    });
    expect(rows(campaignPacingFields(run, { warning: false }))).toEqual({});
  });

  it("shows a held journey run's reason and resume time", () => {
    expect(
      rows(
        holdFields({ holdReason: "whatsapp_messaging_limit", holdUntil: "2026-10-19T08:00:00Z" }),
      ),
    ).toEqual({
      Held: holdLabel("whatsapp_messaging_limit"),
      "Resumes by": "2026-10-19T08:00:00Z",
    });
  });
});
