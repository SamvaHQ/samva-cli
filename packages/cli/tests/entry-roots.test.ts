import { describe, expect, it } from "@effect/vitest";
import { TEMPLATE_ENTRY_ROOTS } from "@samva/core/templates/publication";

import { ENTRY_ROOTS } from "../src/commands/templates/project";

describe("template entry roots", () => {
  it("match the roots the platform accepts", () => {
    expect([...ENTRY_ROOTS]).toEqual([...TEMPLATE_ENTRY_ROOTS]);
  });
});
