/**
 * JSON Schema (draft 2020-12) to TypeScript, for the exact subset a template
 * input schema can contain.
 *
 * `@samva/markup`'s `inputSchema` already refuses every non-portable construct
 * before a template can publish, so this emitter's job is not to be a general
 * converter. It is to refuse loudly whatever it has not been taught, because a
 * generated `unknown` would silently stop checking the caller's input, which is
 * the entire point of generating the type.
 */
import * as Predicate from "effect/Predicate";

const RESERVED = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
]);

const SAFE_PROPERTY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  Predicate.isObject(value) && !Array.isArray(value);

/** `password-reset` becomes `PasswordReset`; anything unusable becomes a numbered fallback. */
export const pascalCase = (value: string, fallback: string): string => {
  const parts = value.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = parts
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("")
    .replace(/^[0-9]+/, "");
  return joined.length === 0 || RESERVED.has(joined.toLowerCase()) ? fallback : joined;
};

/**
 * A type expression as the emitter builds it, printed later at the column and indentation it lands
 * on. Printing here, rather than splicing strings, is what keeps the generated module exactly what
 * the repository formatter would write: nested objects indent with their depth, and a union that
 * does not fit the line breaks one member per line.
 */
export type TypeDoc =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "object";
      readonly members: readonly {
        readonly name: string;
        readonly optional: boolean;
        readonly type: TypeDoc;
      }[];
    }
  | { readonly kind: "union"; readonly members: readonly TypeDoc[] }
  | { readonly kind: "intersection"; readonly members: readonly TypeDoc[] }
  | { readonly kind: "array"; readonly element: TypeDoc }
  | { readonly kind: "tuple"; readonly members: readonly TypeDoc[]; readonly rest?: TypeDoc }
  | { readonly kind: "record"; readonly value: TypeDoc };

const text = (value: string): TypeDoc => ({ kind: "text", text: value });
const NEVER = text("never");

/** One member is that member; a union of unions is one flat union, as the formatter prints it. */
const union = (members: readonly TypeDoc[]): TypeDoc =>
  members.length === 1
    ? (members[0] ?? NEVER)
    : { kind: "union", members: members.flatMap((m) => (m.kind === "union" ? m.members : [m])) };

/** The formatter's line width. */
export const PRINT_WIDTH = 100;

const pad = (indent: number): string => " ".repeat(indent);

/** Whether a type prints on one line however long it is: objects always break. */
const isFlat = (doc: TypeDoc): boolean => {
  switch (doc.kind) {
    case "text":
      return true;
    case "object":
      return false;
    case "union":
    case "intersection":
      return doc.members.every(isFlat);
    case "array":
      return isFlat(doc.element);
    case "tuple":
      return doc.members.every(isFlat) && (doc.rest === undefined || isFlat(doc.rest));
    case "record":
      return isFlat(doc.value);
  }
};

const flat = (doc: TypeDoc): string => {
  switch (doc.kind) {
    case "text":
      return doc.text;
    case "object":
      return `{ ${doc.members
        .map(({ name, optional, type }) => `readonly ${name}${optional ? "?" : ""}: ${flat(type)}`)
        .join("; ")} }`;
    case "union":
      return doc.members.map(flat).join(" | ");
    case "intersection":
      return doc.members.map(operand).join(" & ");
    case "array":
      return `readonly ${wrapped(doc.element)}[]`;
    case "tuple":
      return `readonly [${[...doc.members.map(flat), ...(doc.rest === undefined ? [] : [`...${flat(doc.rest)}[]`])].join(", ")}]`;
    case "record":
      return `Record<string, ${flat(doc.value)}>`;
  }
};

/**
 * An array element: a bare name or an object needs no parentheses; a composed type does, and so
 * does another array, because `readonly readonly T[][]` is not a type.
 */
const needsParentheses = (doc: TypeDoc): boolean =>
  doc.kind === "union" ||
  doc.kind === "intersection" ||
  doc.kind === "array" ||
  doc.kind === "tuple";

/** An intersection operand: a union binds looser than `&`, so it needs parentheses. */
const operand = (doc: TypeDoc): string => (doc.kind === "union" ? `(${flat(doc)})` : flat(doc));

const wrapped = (doc: TypeDoc): string => (needsParentheses(doc) ? `(${flat(doc)})` : flat(doc));

/**
 * The type as it prints starting at `column` inside a construct indented by `indent` spaces. A
 * result that starts with a newline is a broken union: the caller writes no space before it.
 * `suffix` is the width of what the caller appends on the last line, such as `;`.
 */
export const printType = (doc: TypeDoc, indent: number, column: number, suffix = 1): string => {
  switch (doc.kind) {
    case "object":
      return `{\n${doc.members
        .map(({ name, optional, type }) => {
          const head = `${pad(indent + 2)}readonly ${name}${optional ? "?" : ""}:`;
          const body = printType(type, indent + 2, head.length + 1);
          return `${head}${body.startsWith("\n") ? "" : " "}${body};`;
        })
        .join("\n")}\n${pad(indent)}}`;
    case "union": {
      if (isFlat(doc) && column + flat(doc).length + suffix <= PRINT_WIDTH) return flat(doc);
      // A member sits two columns in, and what an object member holds sits two columns past `| `.
      return doc.members
        .map((member) => `\n${pad(indent + 2)}| ${printType(member, indent + 4, indent + 4, 0)}`)
        .join("");
    }
    case "intersection":
      return doc.members
        .map((member) => {
          const body = printType(member, indent, column, suffix);
          if (member.kind !== "union") return body;
          return body.startsWith("\n") ? `(${body}\n${pad(indent)})` : `(${body})`;
        })
        .join(" & ");
    case "array": {
      const element = doc.element;
      if (isFlat(doc) && column + flat(doc).length + suffix <= PRINT_WIDTH) return flat(doc);
      if (element.kind === "object")
        return `readonly ${printType(element, indent, column + 9, 0)}[]`;
      if (!needsParentheses(element)) return flat(doc);
      const body = printType(element, indent, column + 10, 0);
      return body.startsWith("\n")
        ? `readonly (${body}\n${pad(indent)})[]`
        : `readonly (${body})[]`;
    }
    default:
      return flat(doc);
  }
};

export interface SchemaTypeProblem {
  /** Where in the schema the emitter stopped, as a JSON pointer. */
  readonly pointer: string;
  readonly message: string;
}

interface EmitterState {
  readonly prefix: string;
  readonly defs: Map<string, TypeDoc>;
  readonly emitting: Set<string>;
  /** Emitted type name to the `$defs` key it came from, to catch collisions. */
  readonly named: Map<string, string>;
  readonly problems: SchemaTypeProblem[];
}

const UNSUPPORTED_KEYWORDS = [
  "not",
  "if",
  "then",
  "else",
  "patternProperties",
  "dependentSchemas",
  "dependentRequired",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contains",
  "propertyNames",
  "$dynamicRef",
] as const;

const literal = (value: unknown, pointer: string, state: EmitterState): TypeDoc => {
  if (value === null) return text("null");
  if (typeof value === "string") return text(JSON.stringify(value));
  if (typeof value === "number" || typeof value === "boolean") return text(String(value));
  state.problems.push({
    pointer,
    message: "Only string, number, boolean and null literals become generated types.",
  });
  return NEVER;
};

const scalar = (type: string, pointer: string, state: EmitterState): TypeDoc => {
  switch (type) {
    case "string":
      return text("string");
    case "number":
    case "integer":
      return text("number");
    case "boolean":
      return text("boolean");
    case "null":
      return text("null");
    default:
      state.problems.push({ pointer, message: `Unsupported JSON Schema type ${type}.` });
      return NEVER;
  }
};

/**
 * Two `$defs` keys can Pascal-case to one name — `foo-bar` and `fooBar` both
 * become `FooBar` — and whichever was reached first would silently answer for
 * both, so one definition would be generated with the other's shape. Refuse and
 * name both keys instead.
 */
const definitionName = (
  state: EmitterState,
  key: string,
  index: number,
  pointer: string,
): string | undefined => {
  const name = `${state.prefix}${pascalCase(key, `Def${index}`)}`;
  const claimed = state.named.get(name);
  if (claimed !== undefined && claimed !== key) {
    state.problems.push({
      pointer,
      message: `Definitions ${claimed} and ${key} both generate the type ${name}; rename one.`,
    });
    return undefined;
  }
  state.named.set(name, key);
  return name;
};

const emit = (
  schema: unknown,
  pointer: string,
  root: Record<string, unknown>,
  state: EmitterState,
): TypeDoc => {
  if (schema === true) {
    state.problems.push({
      pointer,
      message: "An unconstrained schema cannot produce a type that checks anything.",
    });
    return NEVER;
  }
  if (schema === false) return NEVER;
  if (!isObject(schema)) {
    state.problems.push({ pointer, message: "Expected a JSON Schema object." });
    return NEVER;
  }
  for (const keyword of UNSUPPORTED_KEYWORDS) {
    if (schema[keyword] !== undefined) {
      state.problems.push({
        pointer,
        message: `Generated types do not support the ${keyword} keyword.`,
      });
      return NEVER;
    }
  }
  const reference = schema.$ref;
  if (typeof reference === "string") {
    const key = reference.startsWith("#/$defs/") ? reference.slice("#/$defs/".length) : undefined;
    const defs = isObject(root.$defs) ? root.$defs : undefined;
    if (key === undefined || defs === undefined || defs[key] === undefined) {
      state.problems.push({
        pointer,
        message: `Only local #/$defs references are generated; found ${reference}.`,
      });
      return NEVER;
    }
    const name = definitionName(state, key, Object.keys(defs).indexOf(key), pointer);
    if (name === undefined) return NEVER;
    // Emit the definition once, and reserve its name before recursing so a
    // recursive schema names itself instead of expanding forever.
    if (!state.defs.has(name) && !state.emitting.has(name)) {
      state.emitting.add(name);
      state.defs.set(name, emit(defs[key], `#/$defs/${key}`, root, state));
    }
    return text(name);
  }
  if (schema.const !== undefined) return literal(schema.const, pointer, state);
  if (Array.isArray(schema.enum)) {
    return schema.enum.length === 0
      ? NEVER
      : union(schema.enum.map((value) => literal(value, pointer, state)));
  }
  if (Array.isArray(schema.allOf)) {
    return {
      kind: "intersection",
      members: schema.allOf.map((member, index) =>
        emit(member, `${pointer}/allOf/${index}`, root, state),
      ),
    };
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const members = schema[key];
    if (!Array.isArray(members)) continue;
    return members.length === 0
      ? NEVER
      : union(
          members.map((member, index) => emit(member, `${pointer}/${key}/${index}`, root, state)),
        );
  }
  const type = schema.type;
  if (Array.isArray(type)) {
    return union(type.map((member) => scalarOrStructured(schema, member, pointer, root, state)));
  }
  if (typeof type !== "string") {
    state.problems.push({
      pointer,
      message: "A generated type needs an explicit type, enum, const, $ref or composition.",
    });
    return NEVER;
  }
  return scalarOrStructured(schema, type, pointer, root, state);
};

const scalarOrStructured = (
  schema: Record<string, unknown>,
  type: unknown,
  pointer: string,
  root: Record<string, unknown>,
  state: EmitterState,
): TypeDoc => {
  if (typeof type !== "string") {
    state.problems.push({ pointer, message: "Expected a JSON Schema type name." });
    return NEVER;
  }
  if (type === "object") {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((key) => typeof key === "string")
        : [],
    );
    const keys = Object.keys(properties);
    const additional = schema.additionalProperties;
    if (keys.length === 0) {
      if (additional === undefined || additional === true) {
        state.problems.push({
          pointer,
          message: "An object with no declared properties cannot produce a type that checks input.",
        });
        return NEVER;
      }
      return additional === false
        ? { kind: "record", value: NEVER }
        : {
            kind: "record",
            value: emit(additional, `${pointer}/additionalProperties`, root, state),
          };
    }
    const declared = keys.map((key) => ({
      name: SAFE_PROPERTY.test(key) ? key : JSON.stringify(key),
      optional: !required.has(key),
      type: emit(properties[key], `${pointer}/properties/${key}`, root, state),
    }));
    const shape: TypeDoc = { kind: "object", members: declared };
    if (additional === undefined || additional === false || additional === true) return shape;
    // A declared property and an open value type cannot both live in one object
    // literal: an index signature has to accept every declared property, and
    // `{ name: string }` with `[key: string]: number` is a type nothing
    // satisfies. The intersection compiles and keeps every declared property
    // exactly checked. Its one looseness is deliberate: the open value type has
    // to include the declared types or nothing would satisfy it, so an extra
    // key typed like a declared property passes here and the API rejects it.
    const extra = emit(additional, `${pointer}/additionalProperties`, root, state);
    const seen = new Set<string>();
    const open = [...declared.map((member) => member.type), extra].filter((member) => {
      const key = flat(member);
      if (key === "never" || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return {
      kind: "intersection",
      members: [shape, { kind: "record", value: open.length === 0 ? NEVER : union(open) }],
    };
  }
  if (type === "array") {
    if (Array.isArray(schema.prefixItems)) {
      const tuple = schema.prefixItems.map((member, index) =>
        emit(member, `${pointer}/prefixItems/${index}`, root, state),
      );
      return {
        kind: "tuple",
        members: tuple,
        ...(schema.items === undefined || schema.items === false
          ? {}
          : { rest: emit(schema.items, `${pointer}/items`, root, state) }),
      };
    }
    if (schema.items === undefined) {
      state.problems.push({
        pointer,
        message: "An array without declared items cannot produce a type that checks input.",
      });
      return NEVER;
    }
    return { kind: "array", element: emit(schema.items, `${pointer}/items`, root, state) };
  }
  return scalar(type, pointer, state);
};

export interface SchemaTypeResult {
  /** The input type expression, referring to any named definitions below. */
  readonly type: TypeDoc;
  /** `name` to type expression, in the order they were first reached. */
  readonly definitions: readonly { readonly name: string; readonly type: TypeDoc }[];
  readonly problems: readonly SchemaTypeProblem[];
}

/**
 * `prefix` namespaces the schema's `$defs` so two templates that both declare a
 * `Node` definition emit two distinct types in one module.
 */
export const schemaToTypeScript = (
  schema: Record<string, unknown>,
  prefix: string,
): SchemaTypeResult => {
  const state: EmitterState = {
    prefix,
    defs: new Map(),
    emitting: new Set(),
    named: new Map(),
    problems: [],
  };
  const type = emit(schema, "#", schema, state);
  return {
    type,
    definitions: [...state.defs].map(([name, definition]) => ({ name, type: definition })),
    problems: state.problems,
  };
};
