import { describe, expect, it } from "@effect/vitest";

import { deviceLoginInstructions } from "../src/commands/login";

const device = {
  device_code: "device-code",
  user_code: "ABCD2345",
  verification_uri: "https://samva.dev/device",
  expires_in: 1800,
  interval: 5,
};

describe("deviceLoginInstructions", () => {
  it("leads with the complete link and names the bare page as the manual-entry route", () => {
    const text = deviceLoginInstructions({
      ...device,
      verification_uri_complete: "https://samva.dev/device?user_code=ABCD2345",
    });

    expect(text.trimStart().split("\n").slice(0, 3)).toEqual([
      "To authorize the Samva CLI, open:",
      "",
      "  https://samva.dev/device?user_code=ABCD2345",
    ]);
    expect(text).toContain("confirm it shows the code:\n\n  ABCD2345\n");
    expect(text).toContain("go to https://samva.dev/device and enter the code.");
  });

  it("asks for manual entry when the server sends no complete link", () => {
    const text = deviceLoginInstructions(device);

    expect(text).toContain(
      "open:\n\n  https://samva.dev/device\n\nand enter the code:\n\n  ABCD2345\n",
    );
    expect(text).not.toContain("confirm");
  });
});
