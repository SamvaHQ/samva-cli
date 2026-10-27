import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "@effect/vitest";

import {
  readTemplateTypesManifest,
  renderTemplateTypes,
  templateTypesDrift,
} from "../src/commands/templates/generated-module";
import { printType, schemaToTypeScript } from "../src/commands/templates/schema-types";
import {
  catalog,
  digestSchema,
  receiptSchema,
  welcomeSchema,
  wideCatalog,
} from "./support/template-catalog";

const origin = "https://api.samva.dev";

/** A schema type as the module writes it, at the top of a declaration. */
const printed = (type: Parameters<typeof printType>[0]) => printType(type, 0, 0);

describe("template input types", () => {
  it("types required, optional, enum and recursive input from the published schema", () => {
    const welcome = schemaToTypeScript(welcomeSchema, "Welcome");
    expect(welcome).toMatchObject({ definitions: [], problems: [] });
    expect(printed(welcome.type)).toBe(
      [
        "{",
        "  readonly firstName: string;",
        '  readonly plan: "free" | "pro";',
        "  readonly seats: number;",
        "  readonly invitedBy?: string;",
        "}",
      ].join("\n"),
    );

    const digest = schemaToTypeScript(digestSchema, "WeeklyDigest");
    expect(digest.problems).toEqual([]);
    // The recursive definition names itself instead of expanding forever.
    expect(digest.definitions.map(({ name, type }) => [name, printed(type)])).toEqual([
      [
        "WeeklyDigestItem",
        [
          "{",
          "  readonly title: string;",
          "  readonly children?: readonly WeeklyDigestItem[];",
          "}",
        ].join("\n"),
      ],
    ]);
    expect(printed(digest.type)).toContain("readonly WeeklyDigestItem[]");
  });

  it("types declared properties beside an open additional type as one that compiles", () => {
    // An index signature cannot accept both `orderId: string` and
    // `total: number`; the intersection is the shape that does.
    const rendered = schemaToTypeScript(receiptSchema, "Receipt");
    expect(rendered.problems).toEqual([]);
    expect(printed(rendered.type)).toBe(
      [
        "{",
        "  readonly orderId: string;",
        "  readonly total: number;",
        "} & Record<string, string | number>",
      ].join("\n"),
    );
  });

  it("refuses a schema it cannot type rather than generating something that checks nothing", () => {
    expect(
      schemaToTypeScript({ type: "object", properties: { any: {} }, required: ["any"] }, "X")
        .problems,
    ).toEqual([
      {
        pointer: "#/properties/any",
        message: "A generated type needs an explicit type, enum, const, $ref or composition.",
      },
    ]);
    expect(schemaToTypeScript({ type: "object", not: { type: "string" } }, "X").problems).toEqual([
      { pointer: "#", message: "Generated types do not support the not keyword." },
    ]);
    expect(
      schemaToTypeScript(
        {
          type: "object",
          properties: { at: { $ref: "https://example.test/at" } },
          required: ["at"],
        },
        "X",
      ).problems,
    ).toEqual([
      {
        pointer: "#/properties/at",
        message: "Only local #/$defs references are generated; found https://example.test/at.",
      },
    ]);
  });

  it("parenthesizes the types that bind looser than an array or an intersection", () => {
    const nested = schemaToTypeScript(
      {
        type: "object",
        properties: {
          grid: { type: "array", items: { type: "array", items: { type: "string" } } },
          pairs: {
            type: "array",
            items: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }] },
          },
        },
        required: ["grid", "pairs"],
        additionalProperties: false,
      },
      "X",
    );
    expect(printed(nested.type)).toBe(
      [
        "{",
        "  readonly grid: readonly (readonly string[])[];",
        "  readonly pairs: readonly (readonly [string, number])[];",
        "}",
      ].join("\n"),
    );

    const combined = schemaToTypeScript(
      {
        allOf: [
          {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
          {
            anyOf: [
              {
                type: "object",
                properties: { a: { type: "string" } },
                required: ["a"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: { b: { type: "number" } },
                required: ["b"],
                additionalProperties: false,
              },
            ],
          },
        ],
      },
      "X",
    );
    expect(printed(combined.type)).toBe(
      [
        "{",
        "  readonly id: string;",
        "} & (",
        "  | {",
        "      readonly a: string;",
        "    }",
        "  | {",
        "      readonly b: number;",
        "    }",
        ")",
      ].join("\n"),
    );
  });

  it("refuses two definitions that would generate one type name", () => {
    const colliding = {
      type: "object",
      properties: { a: { $ref: "#/$defs/foo-bar" }, b: { $ref: "#/$defs/fooBar" } },
      required: ["a", "b"],
      additionalProperties: false,
      $defs: {
        "foo-bar": {
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"],
          additionalProperties: false,
        },
        fooBar: {
          type: "object",
          properties: { y: { type: "number" } },
          required: ["y"],
          additionalProperties: false,
        },
      },
    };
    expect(schemaToTypeScript(colliding, "X").problems).toEqual([
      {
        pointer: "#/properties/b",
        message: "Definitions foo-bar and fooBar both generate the type XFooBar; rename one.",
      },
    ]);
  });

  it("defaults to an exact publication reference and opts into a contract explicitly", () => {
    const exact = renderTemplateTypes({ entries: catalog, by: "id", reference: "exact", origin });
    expect(exact.source).toContain(
      'welcome: { templateId: "tmpl_2eqcmea000000000", publicationId: "tpub_2eqcmea000000000" }',
    );
    expect(exact.source).not.toContain("inputContractId");

    const latest = renderTemplateTypes({
      entries: catalog,
      by: "id",
      reference: "contract-latest",
      origin,
    });
    expect(latest.source).toContain(
      'welcome: { templateId: "tmpl_2eqcmea000000000", inputContractId: "tcon_2eqcmea000000000" }',
    );
    expect(latest.source).not.toContain("publicationId");
    expect(readTemplateTypesManifest(latest.source)?.reference).toBe("contract-latest");
  });

  it("skips a template that has nothing to reference yet, naming why", () => {
    const generated = renderTemplateTypes({
      entries: [
        ...catalog,
        { key: "draft", templateId: "tmpl_4qraft0000000000", inputSchema: welcomeSchema },
      ],
      by: "id",
      reference: "exact",
      origin,
    });
    expect(generated.skipped).toEqual([
      {
        key: "draft",
        reason: "no publication yet; publish the template before generating an exact reference",
      },
    ]);
    expect(generated.manifest.templates.map(({ key }) => key)).toEqual([
      "receipt",
      "weekly-digest",
      "welcome",
    ]);
  });

  it("is the exact module checked into the consumer project", () => {
    const consumer = (name: string) =>
      readFileSync(fileURLToPath(new URL(`./consumer/${name}`, import.meta.url)), "utf8");
    expect(
      renderTemplateTypes({ entries: catalog, by: "id", reference: "exact", origin }).source,
    ).toBe(consumer("samva-templates.ts"));
    expect(
      renderTemplateTypes({ entries: catalog, by: "slug", reference: "exact", origin }).source,
    ).toBe(consumer("samva-templates-by-slug.ts"));
    // The wide catalog's layout is what the repository formatter writes, so `format:check` holds
    // these files to it.
    expect(
      renderTemplateTypes({ entries: wideCatalog, by: "id", reference: "exact", origin }).source,
    ).toBe(consumer("samva-templates-wide.ts"));
    expect(
      renderTemplateTypes({ entries: wideCatalog, by: "slug", reference: "exact", origin }).source,
    ).toBe(consumer("samva-templates-wide-by-slug.ts"));
  });

  it("renames a generated type that would redeclare one the module writes itself", () => {
    // A template `template` with definitions `Slug` and `Values` would declare `TemplateSlug` and
    // `TemplateValues` a second time.
    const generated = renderTemplateTypes({
      entries: [
        {
          key: "template",
          templateId: "tmpl_6qece3pt000000000",
          publicationId: "tpub_6qece3pt000000000",
          inputSchema: {
            type: "object",
            properties: { slug: { $ref: "#/$defs/Slug" }, values: { $ref: "#/$defs/Values" } },
            required: ["slug", "values"],
            additionalProperties: false,
            $defs: { Slug: { type: "string" }, Values: { type: "number" } },
          },
        },
      ],
      by: "id",
      reference: "exact",
      origin,
    });
    expect(generated.problems).toEqual([]);
    const declarations = [...generated.source.matchAll(/^(?:export )?type (\w+)\b/gm)].map(
      (match) => match[1],
    );
    expect(declarations.length).toBe(new Set(declarations).size);
    expect(generated.source).toContain("type Template_Slug = string;");
    expect(generated.source).toContain("type Template_Values = number;");
    expect(generated.source).toContain("export type Template_Input =");
  });

  describe("by slug", () => {
    const bySlug = renderTemplateTypes({
      entries: catalog,
      by: "slug",
      reference: "exact",
      origin,
    });

    it("names each template by slug alone and follows its input contract", () => {
      expect(bySlug.source).toContain(
        "(\n  slug: Slug,\n  templateData: SamvaTemplateInputs[Slug],\n) => ({ templateSlug: slug, templateData: asTemplateData(templateData) })",
      );
      // The API accepts a publication or contract reference only beside a template id.
      expect(bySlug.source).not.toContain("samvaTemplates");
      expect(bySlug.source).not.toContain("publicationId");
      // No reference: the send renders the current publication, so the file records only the
      // input contract its types came from.
      expect(bySlug.manifest).toEqual({
        version: 1,
        by: "slug",
        templates: [
          {
            key: "receipt",
            templateId: "tmpl_6qece3pt000000000",
            inputContractId: "tcon_6qece3pt000000000",
          },
          {
            key: "weekly-digest",
            templateId: "tmpl_3rgest0000000000",
            inputContractId: "tcon_3rgest0000000000",
          },
          {
            key: "welcome",
            templateId: "tmpl_2eqcmea000000000",
            inputContractId: "tcon_2eqcmea000000000",
          },
        ],
      });
      expect(bySlug.source).not.toContain("contract-latest");
      expect(bySlug.source).not.toContain('"reference"');
    });

    it("skips a template that has no input contract yet, naming why", () => {
      const generated = renderTemplateTypes({
        entries: [
          ...catalog,
          { key: "draft", templateId: "tmpl_4qraft0000000000", inputSchema: welcomeSchema },
        ],
        by: "slug",
        reference: "exact",
        origin,
      });
      expect(generated.skipped).toEqual([
        {
          key: "draft",
          reason: "no input contract yet; publish the template before generating types by slug",
        },
      ]);
    });

    it("exports the slug type in both modes, for a generic mailer", () => {
      const byId = renderTemplateTypes({ entries: catalog, by: "id", reference: "exact", origin });
      for (const generated of [bySlug, byId])
        expect(generated.source).toContain("export type TemplateSlug = keyof SamvaTemplateInputs;");
    });
  });
});

describe("generated template type drift", () => {
  const generated = renderTemplateTypes({ entries: catalog, by: "id", reference: "exact", origin });

  it("reports no drift for the file a regeneration would write", () => {
    expect(templateTypesDrift(generated.source, generated)).toEqual([]);
  });

  it("names a missing file, a hand-edited file, and a file this command did not write", () => {
    expect(templateTypesDrift(undefined, generated)).toEqual([
      { kind: "missing", detail: "The generated file does not exist." },
    ]);
    expect(templateTypesDrift("export const samvaTemplates = {};\n", generated)).toEqual([
      {
        kind: "unreadable",
        detail: "The file carries no samva:catalog manifest; it was not written by this command.",
      },
    ]);
    expect(
      templateTypesDrift(`${generated.source}\n// hand edit\n`, generated).map(({ kind }) => kind),
    ).toEqual(["modified"]);
  });

  it("names which template moved, in which way", () => {
    const republished = renderTemplateTypes({
      entries: [
        catalog[0]!,
        catalog[1]!,
        { ...catalog[2]!, publicationId: "tpub_2eqcmea111111111" },
        {
          key: "invoice",
          templateId: "tmpl_5rec3ept000000000",
          publicationId: "tpub_5rec3ept000000000",
          inputSchema: welcomeSchema,
        },
      ],
      by: "id",
      reference: "exact",
      origin,
    });
    const removed = renderTemplateTypes({
      entries: [catalog[2]!],
      by: "id",
      reference: "exact",
      origin,
    });

    expect(templateTypesDrift(generated.source, republished)).toEqual([
      {
        kind: "added",
        key: "invoice",
        detail: "invoice is published and not in the file.",
      },
      {
        kind: "reference",
        key: "welcome",
        detail:
          "welcome references tpub_2eqcmea000000000; the catalog now has tpub_2eqcmea111111111.",
      },
    ]);
    expect(templateTypesDrift(generated.source, removed).map(({ key }) => key)).toEqual([
      "receipt",
      "weekly-digest",
    ]);
  });

  describe("under a contract-latest reference", () => {
    const latest = renderTemplateTypes({
      entries: catalog,
      by: "id",
      reference: "contract-latest",
      origin,
    });

    it("does not call a documentation-only republish drift", () => {
      // A republish that only rewords descriptions keeps the input contract, so
      // the reference the file carries still resolves to it — and the generated
      // types never carried the descriptions in the first place.
      const documented = renderTemplateTypes({
        entries: catalog.map((entry) => ({
          ...entry,
          publicationId: `${entry.publicationId?.slice(0, -1) ?? ""}9`,
          inputSchema: {
            ...entry.inputSchema,
            description: "Reworded for the docs site.",
            properties: Object.fromEntries(
              Object.entries(
                (entry.inputSchema?.properties ?? {}) as Record<string, Record<string, unknown>>,
              ).map(([key, property]) => [key, { ...property, description: `About ${key}.` }]),
            ),
          },
        })),
        by: "id",
        reference: "contract-latest",
        origin,
      });
      expect(templateTypesDrift(latest.source, documented)).toEqual([]);
      expect(documented.source).toBe(latest.source);
    });

    it("calls a validation change drift, because it mints the next contract", () => {
      const revalidated = renderTemplateTypes({
        entries: [
          catalog[0]!,
          catalog[1]!,
          { ...catalog[2]!, inputContractId: "tcon_2eqcmea111111111" },
        ],
        by: "id",
        reference: "contract-latest",
        origin,
      });
      expect(templateTypesDrift(latest.source, revalidated)).toEqual([
        {
          kind: "reference",
          key: "welcome",
          detail:
            "welcome references tcon_2eqcmea000000000; the catalog now has tcon_2eqcmea111111111.",
        },
      ]);
    });
  });

  it("reports a keying the file was not generated with, and reads a file without one as by id", () => {
    const bySlug = renderTemplateTypes({
      entries: catalog,
      by: "slug",
      reference: "exact",
      origin,
    });
    expect(templateTypesDrift(generated.source, bySlug)).toEqual([
      { kind: "keying", detail: "Generated by id; asked for slug." },
    ]);
    expect(templateTypesDrift(bySlug.source, generated)).toEqual([
      { kind: "keying", detail: "Generated by slug; asked for id." },
    ]);
    expect(templateTypesDrift(bySlug.source, bySlug)).toEqual([]);
    // By slug, only a new input contract is drift; a republish that keeps it is not.
    const revalidated = renderTemplateTypes({
      entries: [
        catalog[0]!,
        catalog[1]!,
        { ...catalog[2]!, inputContractId: "tcon_2eqcmea111111111" },
      ],
      by: "slug",
      reference: "exact",
      origin,
    });
    expect(templateTypesDrift(bySlug.source, revalidated)).toEqual([
      {
        kind: "contract",
        key: "welcome",
        detail:
          "welcome was typed from input contract tcon_2eqcmea000000000; the catalog now has tcon_2eqcmea111111111.",
      },
    ]);
    const republished = renderTemplateTypes({
      entries: catalog.map((entry) => ({ ...entry, publicationId: "tpub_new00000000000" })),
      by: "slug",
      reference: "exact",
      origin,
    });
    expect(templateTypesDrift(bySlug.source, republished)).toEqual([]);
    const older = generated.source.replace('"by":"id",', "");
    expect(readTemplateTypesManifest(older)?.by).toBe("id");
  });

  it("reports a reference kind the file was not generated with", () => {
    const latest = renderTemplateTypes({
      entries: catalog,
      by: "id",
      reference: "contract-latest",
      origin,
    });
    expect(templateTypesDrift(generated.source, latest)).toEqual([
      {
        kind: "reference",
        detail: "Generated with exact references; asked for contract-latest.",
      },
    ]);
  });
});
