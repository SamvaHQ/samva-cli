import { describe, expect, it } from "@effect/vitest";
import type { BuildTemplatesResult } from "@samva/vite/build";

import {
  collectBuildProblems,
  parseTypeScriptDiagnostics,
  isSuccessfulBuild,
  toTemplateBuildArtifact,
} from "../src/commands/templates";

const diagnostic = (
  code: string,
  severity: "error" | "warning",
  extra: Record<string, unknown> = {},
) => ({ code, severity, message: `${code} message`, origins: [], ...extra });

const okTemplate = {
  template: "welcome",
  channels: ["email" as const],
  ok: true,
  source: "templates/welcome.tsx",
  inputSchema: {},
  compiled: { sml: 1 as const, template: "welcome", schema: {} },
  fixtures: [],
  diagnostics: [],
  compatibility: [],
};

const okFile = { id: "templates/welcome.tsx", kind: "tsx" as const, ok: true, diagnostics: [] };

const result = (files: BuildTemplatesResult["files"], ok = true): BuildTemplatesResult => ({
  compilerVersion: "@samva/markup@0.1.0",
  files,
  diagnostics: [],
  ok,
});

describe("isSuccessfulBuild", () => {
  it("fails on an entry that did not compile and on an empty directory", () => {
    const failed = result(
      [
        {
          id: "templates/welcome.tsx",
          kind: "tsx",
          ok: false,
          diagnostics: [
            diagnostic("invalid-template", "error", {
              origins: [{ fileName: "templates/welcome.tsx", lineNumber: 5, columnNumber: 9 }],
              fix: "Declare an id.",
            }),
          ],
        },
      ],
      false,
    );
    expect(isSuccessfulBuild(failed)).toBe(false);
    expect(collectBuildProblems(failed)).toEqual([
      expect.objectContaining({
        file: "templates/welcome.tsx",
        phase: "compile",
        provenance: "tsx",
        severity: "error",
        code: "invalid-template",
        line: 5,
        column: 9,
        range: { start: { line: 5, column: 9 } },
        fix: "Declare an id.",
      }),
    ]);
    expect(isSuccessfulBuild(result([]))).toBe(false);
  });

  it("attributes fixture errors to their fixture and separates compatibility findings", () => {
    const built = result(
      [
        {
          ...okFile,
          ok: false,
          template: {
            ...okTemplate,
            ok: false,
            fixtures: [
              {
                name: "other",
                input: {},
                ok: false,
                diagnostics: [diagnostic("invalid-fixture", "error")],
              },
            ],
            compatibility: [
              diagnostic("caniemail/css-gap", "warning"),
              diagnostic("caniemail/css-blocked", "error"),
            ],
          },
        },
      ],
      false,
    );
    expect(collectBuildProblems(built)).toEqual([
      expect.objectContaining({ code: "invalid-fixture", fixture: "other", phase: "compile" }),
      expect.objectContaining({ code: "caniemail/css-blocked", phase: "compatibility" }),
    ]);
  });

  it("accepts a clean build and carries a compiler edit through unchanged", () => {
    const edit = { range: { start: 1, end: 2 }, text: "x" };
    const clean = result([{ ...okFile, template: okTemplate }]);
    expect(isSuccessfulBuild(clean)).toBe(true);
    const withEdit = result(
      [{ ...okFile, ok: false, diagnostics: [diagnostic("needs-edit", "error", { edit })] }],
      false,
    );
    expect(collectBuildProblems(withEdit)[0]).toMatchObject({ edit });
  });
});

describe("toTemplateBuildArtifact", () => {
  it("versions the build payload without dropping its artifacts", () => {
    const built = result([{ ...okFile, template: okTemplate }]);
    expect(toTemplateBuildArtifact(built)).toEqual({
      schemaVersion: 4,
      compilerVersion: "@samva/markup@0.1.0",
      result: built,
    });
  });
});

describe("parseTypeScriptDiagnostics", () => {
  it("maps tsc --pretty false lines to located diagnostics and keeps other lines verbatim", () => {
    const output = [
      "src/welcome.tsx(12,7): error TS2322: Type 'number' is not assignable to type 'string'.",
      "error TS18003: No inputs were found in config file 'tsconfig.json'.",
      "some unstructured line",
    ].join("\n");

    expect(parseTypeScriptDiagnostics(output, "/project/tsconfig.json")).toEqual([
      {
        file: "src/welcome.tsx",
        code: "TS2322",
        message: "Type 'number' is not assignable to type 'string'.",
        line: 12,
        column: 7,
      },
      {
        file: "/project/tsconfig.json",
        code: "TS18003",
        message: "No inputs were found in config file 'tsconfig.json'.",
      },
      { file: "/project/tsconfig.json", code: "TSC", message: "some unstructured line" },
    ]);
    expect(parseTypeScriptDiagnostics("", "/project/tsconfig.json")).toEqual([]);
  });

  it("names the tsconfig entry that declares the samva:brand and image modules", () => {
    const output = [
      "templates/blocks/header.tsx(4,19): error TS2307: Cannot find module 'samva:brand/avaan' or its corresponding type declarations.",
      "templates/blocks/footer.tsx(1,22): error TS2307: Cannot find module 'samva:brand' or its corresponding type declarations.",
      "templates/blocks/header.tsx(3,18): error TS2307: Cannot find module '../assets/mark.png' or its corresponding type declarations.",
      "templates/welcome.tsx(2,18): error TS2307: Cannot find module './missing' or its corresponding type declarations.",
    ].join("\n");

    expect(
      parseTypeScriptDiagnostics(output, "/project/tsconfig.json").map((entry) => entry.message),
    ).toEqual([
      `Cannot find module 'samva:brand/avaan' or its corresponding type declarations. Add "@samva/markup/samva-brand" to compilerOptions.types in tsconfig.json.`,
      `Cannot find module 'samva:brand' or its corresponding type declarations. Add "@samva/markup/samva-brand" to compilerOptions.types in tsconfig.json.`,
      `Cannot find module '../assets/mark.png' or its corresponding type declarations. Add "vite/client" to compilerOptions.types in tsconfig.json.`,
      "Cannot find module './missing' or its corresponding type declarations.",
    ]);
  });
});
