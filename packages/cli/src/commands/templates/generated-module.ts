import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  pascalCase,
  PRINT_WIDTH,
  printType,
  schemaToTypeScript,
  type SchemaTypeProblem,
  type TypeDoc,
} from "./schema-types";

/**
 * The TypeScript module `samva templates types` writes, and the manifest it
 * carries so a later `--check` can say what drifted rather than only that the
 * bytes differ.
 */

const TEMPLATE_TYPES_MANIFEST_PREFIX = "// samva:catalog ";

export type TemplateReferenceKind = "exact" | "contract-latest";

/**
 * What names a template in a generated send. `id` carries the template id and an exact or
 * contract reference; `slug` carries the slug alone, which the API resolves to the template's
 * current publication, so the types follow its current input contract.
 */
export type TemplateKeying = "id" | "slug";

export interface TemplateCatalogEntry {
  /** The template's slug: the key a caller writes, and the module's own key. */
  readonly key: string;
  readonly templateId: string;
  /** The publication an exact reference pins. Absent before the first publish. */
  readonly publicationId?: string | undefined;
  /** The contract a contract-latest reference adopts. Absent before the first publish. */
  readonly inputContractId?: string | undefined;
  readonly inputSchema?: Record<string, unknown> | undefined;
}

interface TemplateManifestEntry {
  readonly key: string;
  readonly templateId: string;
  /**
   * The identity the generated reference stands on: a publication id under
   * `exact`, an input contract id under `contract-latest`.
   *
   * Under `contract-latest` this is the API's own handle for the schema's
   * validation projection — a contract row is unique per template and
   * validation digest — so a republish that only rewords descriptions keeps it,
   * and one that changes what input is valid mints a new one. Comparing it is
   * therefore comparing validation projections, without re-deriving the
   * projection here where a second implementation could disagree with the API's.
   */
  readonly reference?: string | undefined;
  /**
   * What a file keyed by slug stands on: the template's input contract. A slug send renders the
   * current publication whatever the file says, so only a change to the input contract makes the
   * file's types wrong.
   */
  readonly inputContractId?: string | undefined;
}

export interface TemplateTypesManifest {
  readonly version: 1;
  readonly by: TemplateKeying;
  /** How an id-keyed reference is chosen; a slug-keyed file carries no reference. */
  readonly reference?: TemplateReferenceKind | undefined;
  readonly templates: readonly TemplateManifestEntry[];
}

export interface TemplateTypesModule {
  readonly source: string;
  readonly manifest: TemplateTypesManifest;
  /** Templates the catalog carried but that cannot be generated, with the reason. */
  readonly skipped: readonly { readonly key: string; readonly reason: string }[];
  readonly problems: readonly (SchemaTypeProblem & { readonly key: string })[];
}

const ManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  by: Schema.optionalKey(Schema.Literals(["id", "slug"])),
  reference: Schema.optionalKey(Schema.Literals(["exact", "contract-latest"])),
  templates: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      templateId: Schema.String,
      reference: Schema.optionalKey(Schema.String),
      inputContractId: Schema.optionalKey(Schema.String),
    }),
  ),
});
const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(ManifestSchema));
const withKeying = (
  manifest: Schema.Schema.Type<typeof ManifestSchema>,
): TemplateTypesManifest => ({ ...manifest, by: manifest.by ?? "id" });

/**
 * Reads back the manifest a generated module carries; undefined when it has
 * none or when a hand edit made it unreadable. The file is untrusted text, so
 * it is decoded rather than cast.
 */
export const readTemplateTypesManifest = (source: string): TemplateTypesManifest | undefined => {
  const line = source
    .split("\n")
    .find((candidate) => candidate.startsWith(TEMPLATE_TYPES_MANIFEST_PREFIX));
  return line === undefined
    ? undefined
    : Option.getOrUndefined(
        Option.map(decodeManifest(line.slice(TEMPLATE_TYPES_MANIFEST_PREFIX.length)), withKeying),
      );
};

export interface RenderTemplateTypesInput {
  readonly entries: readonly TemplateCatalogEntry[];
  /** How the generated helper names a template. */
  readonly by: TemplateKeying;
  /** The reference an id-keyed send carries; a slug-keyed send follows the current contract. */
  readonly reference: TemplateReferenceKind;
  /** Recorded in the header so a reader knows which deployment the ids came from. */
  readonly origin: string;
}

/** The types every generated module declares itself. */
const MODULE_TYPE_NAMES = [
  "SamvaTemplateInputs",
  "TemplateContent",
  "TemplateSlug",
  "TemplateValue",
  "TemplateValues",
] as const;

/** A key as an object member: bare when it can be, quoted when it must be. */
const memberKey = (value: string) =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : JSON.stringify(value);

/** `<head><type>;` as the formatter prints it: a broken union starts on its own line. */
const declaration = (head: string, type: TypeDoc): string => {
  const body = printType(type, 0, head.length + 1);
  return `${head}${body.startsWith("\n") ? "" : " "}${body};`;
};

/** An object literal member that breaks one property per line once it passes the print width. */
const mapEntry = (key: string, fields: readonly (readonly [string, string])[]): string => {
  const flat = `  ${key}: { ${fields.map(([name, value]) => `${name}: ${value}`).join(", ")} },`;
  return flat.length <= PRINT_WIDTH
    ? flat
    : [`  ${key}: {`, ...fields.map(([name, value]) => `    ${name}: ${value},`), "  },"].join(
        "\n",
      );
};

export const renderTemplateTypes = (input: RenderTemplateTypesInput): TemplateTypesModule => {
  const bySlug = input.by === "slug";
  // A slug names the template, not a publication, so what a slug-keyed file can follow is the
  // template's current input contract.
  const referenceKind: TemplateReferenceKind = bySlug ? "contract-latest" : input.reference;
  const skipped: { key: string; reason: string }[] = [];
  const problems: (SchemaTypeProblem & { key: string })[] = [];
  const entries = [...input.entries].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
  const generated: {
    entry: TemplateCatalogEntry;
    name: string;
    reference: string;
    type: TypeDoc;
    definitions: readonly { readonly name: string; readonly type: TypeDoc }[];
  }[] = [];
  // Every type the module declares: the helpers it always writes, then each template's input and
  // the definitions its schema names. A generated name that matches one is renamed.
  const declared = new Set<string>(MODULE_TYPE_NAMES);
  for (const [index, entry] of entries.entries()) {
    const reference = referenceKind === "exact" ? entry.publicationId : entry.inputContractId;
    if (reference === undefined) {
      skipped.push({
        key: entry.key,
        reason:
          referenceKind === "exact"
            ? "no publication yet; publish the template before generating an exact reference"
            : bySlug
              ? "no input contract yet; publish the template before generating types by slug"
              : "no input contract yet; publish the template before adopting its contract",
      });
      continue;
    }
    if (entry.inputSchema === undefined) {
      skipped.push({ key: entry.key, reason: "the publication declares no input schema" });
      continue;
    }
    let name = pascalCase(entry.key, `Template${index + 1}`);
    let rendered = schemaToTypeScript(entry.inputSchema, name);
    const typeNames = (): string[] => [
      `${name}Input`,
      ...rendered.definitions.map((definition) => definition.name),
    ];
    while (typeNames().some((typeName) => declared.has(typeName))) {
      name = `${name}_`;
      rendered = schemaToTypeScript(entry.inputSchema, name);
    }
    for (const typeName of typeNames()) declared.add(typeName);
    for (const problem of rendered.problems) problems.push({ ...problem, key: entry.key });
    generated.push({
      entry,
      name,
      reference,
      type: rendered.type,
      definitions: rendered.definitions,
    });
  }
  const manifest: TemplateTypesManifest = {
    version: 1,
    by: input.by,
    ...(bySlug ? {} : { reference: referenceKind }),
    templates: generated.map(({ entry, reference }) => ({
      key: entry.key,
      templateId: entry.templateId,
      ...(bySlug ? { inputContractId: reference } : { reference }),
    })),
  };
  const referenceField = referenceKind === "exact" ? "publicationId" : "inputContractId";
  const referenceNote = bySlug
    ? "Each helper names a template by slug, so a send from this file renders the template's current publication; its input is typed from the input contract current when you generated."
    : referenceKind === "exact"
      ? "Each reference pins one exact publication, so a send from this file renders the same message until you regenerate."
      : "Each reference names an input contract, so a send from this file follows the newest publication that still validates input identically.";
  const definitions = generated.flatMap(({ definitions: members }) =>
    members.map(({ name, type }) => declaration(`type ${name} =`, type)),
  );
  const inputs = generated.map(({ entry, name, type }) =>
    [
      `/** Input for the \`${entry.key}\` template. */`,
      declaration(`export type ${name}Input =`, type),
    ].join("\n"),
  );
  const keying = bySlug
    ? [
        "/**",
        " * Email content for one template, named by slug. TypeScript rejects input the template's",
        " * input contract would reject; spread the result into `email.send`.",
        " */",
        "export const templateContent = <Slug extends TemplateSlug>(",
        "  slug: Slug,",
        "  templateData: SamvaTemplateInputs[Slug],",
        ") => ({ templateSlug: slug, templateData: asTemplateData(templateData) });",
      ]
    : [
        `/** ${referenceNote} */`,
        generated.length === 0
          ? "export const samvaTemplates = {} as const;"
          : `export const samvaTemplates = {\n${generated
              .map(({ entry, reference }) =>
                mapEntry(memberKey(entry.key), [
                  ["templateId", JSON.stringify(entry.templateId)],
                  [referenceField, JSON.stringify(reference)],
                ]),
              )
              .join("\n")}\n} as const;`,
        "",
        "/** What a send spreads in: the template's reference and its input as JSON. */",
        "export type TemplateContent = {",
        "  readonly templateId: string;",
        `  readonly ${referenceField}: string;`,
        "  readonly templateData: TemplateValues;",
        "};",
        "",
        "/**",
        " * Email content for one template. TypeScript rejects input the published",
        " * schema would reject, and the reference travels with it. Spread it into `email.send`.",
        " */",
        "export const templateContent = <Slug extends TemplateSlug>(",
        "  slug: Slug,",
        "  templateData: SamvaTemplateInputs[Slug],",
        "): TemplateContent => ({",
        "  ...samvaTemplates[slug],",
        "  templateData: asTemplateData(templateData),",
        "});",
      ];
  const source = `${[
    "// Generated by `samva templates types`. Do not edit.",
    `//`,
    `// ${generated.length} template${generated.length === 1 ? "" : "s"} from ${input.origin}.`,
    `// ${referenceNote}`,
    `// Re-run after publishing; \`samva templates types --check\` reports drift without writing.`,
    `${TEMPLATE_TYPES_MANIFEST_PREFIX}${JSON.stringify(manifest)}`,
    "",
    ...(definitions.length === 0 ? [] : [definitions.join("\n\n"), ""]),
    ...(inputs.length === 0 ? [] : [inputs.join("\n\n"), ""]),
    "/** What each published template accepts, keyed by slug. */",
    generated.length === 0
      ? "export interface SamvaTemplateInputs {}"
      : `export interface SamvaTemplateInputs {\n${generated
          .map(({ entry, name }) => `  readonly ${memberKey(entry.key)}: ${name}Input;`)
          .join("\n")}\n}`,
    "",
    "/** The slug of every template in this file. */",
    "export type TemplateSlug = keyof SamvaTemplateInputs;",
    "",
    "// What the API accepts as template data. A generated input is made of these values, but its",
    "// readonly lists and optional properties are not always assignable to them, so the helper",
    "// rebuilds the input as JSON values, leaving out a property that is undefined.",
    "type TemplateValue =",
    "  | string",
    "  | number",
    "  | boolean",
    "  | null",
    "  | TemplateValue[]",
    "  | { [key: string]: TemplateValue };",
    "type TemplateValues = { [key: string]: TemplateValue };",
    "const toTemplateValue = (value: unknown): TemplateValue => {",
    '  if (value === null || typeof value === "string") return value;',
    '  if (typeof value === "number" || typeof value === "boolean") return value;',
    "  if (Array.isArray(value)) return value.map(toTemplateValue);",
    '  if (typeof value !== "object") return null;',
    "  return Object.fromEntries(",
    "    Object.entries(value)",
    "      .filter(([, member]) => member !== undefined)",
    "      .map(([key, member]) => [key, toTemplateValue(member)]),",
    "  );",
    "};",
    "const asTemplateData = (input: SamvaTemplateInputs[TemplateSlug]): TemplateValues =>",
    "  Object.fromEntries(",
    "    Object.entries(input)",
    "      .filter(([, member]) => member !== undefined)",
    "      .map(([key, member]) => [key, toTemplateValue(member)]),",
    "  );",
    "",
    ...keying,
  ].join("\n")}\n`;
  return { source, manifest, skipped, problems };
};

export interface TemplateTypesDrift {
  readonly kind:
    | "missing"
    | "unreadable"
    | "keying"
    | "contract"
    | "modified"
    | "added"
    | "removed"
    | "reference"
    | "schema";
  readonly key?: string | undefined;
  readonly detail: string;
}

/**
 * What changed between a generated file and the catalog it claims to describe.
 * An empty result means the file is exactly what a regeneration would write.
 */
export const templateTypesDrift = (
  existing: string | undefined,
  generated: TemplateTypesModule,
): readonly TemplateTypesDrift[] => {
  if (existing === undefined)
    return [{ kind: "missing", detail: "The generated file does not exist." }];
  const manifest = readTemplateTypesManifest(existing);
  if (manifest === undefined)
    return [
      {
        kind: "unreadable",
        detail: "The file carries no samva:catalog manifest; it was not written by this command.",
      },
    ];
  if (manifest.by !== generated.manifest.by)
    return [
      {
        kind: "keying",
        detail: `Generated by ${manifest.by}; asked for ${generated.manifest.by}.`,
      },
    ];
  // A different reference kind changes every entry, so reporting it per
  // template would bury the one fact that explains all of them.
  if (manifest.reference !== generated.manifest.reference)
    return [
      {
        kind: "reference",
        detail: `Generated with ${manifest.reference} references; asked for ${generated.manifest.reference}.`,
      },
    ];
  const drift: TemplateTypesDrift[] = [];
  const before = new Map(manifest.templates.map((entry) => [entry.key, entry]));
  const after = new Map(generated.manifest.templates.map((entry) => [entry.key, entry]));
  for (const [key, entry] of after) {
    const previous = before.get(key);
    if (previous === undefined) {
      drift.push({ kind: "added", key, detail: `${key} is published and not in the file.` });
      continue;
    }
    if (generated.manifest.by === "slug") {
      if (previous.inputContractId !== entry.inputContractId)
        drift.push({
          kind: "contract",
          key,
          detail: `${key} was typed from input contract ${previous.inputContractId}; the catalog now has ${entry.inputContractId}.`,
        });
    } else if (previous.reference !== entry.reference)
      drift.push({
        kind: "reference",
        key,
        detail: `${key} references ${previous.reference}; the catalog now has ${entry.reference}.`,
      });
  }
  for (const key of before.keys())
    if (!after.has(key))
      drift.push({ kind: "removed", key, detail: `${key} is in the file and not in the catalog.` });
  if (drift.length === 0 && existing !== generated.source)
    drift.push({
      kind: "modified",
      detail: "The file was edited by hand; regenerate it instead.",
    });
  return drift;
};
