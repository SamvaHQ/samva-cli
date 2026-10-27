import { describe, expect, it } from "@effect/vitest";

import { reportDiagnostic } from "../src/commands/templates/diagnostics";

describe("reportDiagnostic fixes for local commands", () => {
  const finding = (code: string, fix?: string) => ({
    code,
    severity: "error" as const,
    message: "m",
    origins: [],
    ...(fix === undefined ? {} : { fix }),
  });

  it("names Samva's published asset origin for a missing --asset-base", () => {
    expect(reportDiagnostic(finding("missing-asset-base"), { file: "." }).fix).toContain(
      "--asset-base https://cdn.samva.dev",
    );
  });

  it("tells a partial apart from a template", () => {
    const fix = reportDiagnostic(finding("no-template", "Default-export defineTemplate."), {
      file: "templates/blocks/header.tsx",
    }).fix;
    expect(fix).toContain("Default-export defineTemplate.");
    expect(fix).toContain("render a template that imports it");
  });

  it("keeps the compiler's fix for every other finding", () => {
    expect(reportDiagnostic(finding("unsupported-element", "Use <Text>."), { file: "." }).fix).toBe(
      "Use <Text>.",
    );
  });
});
