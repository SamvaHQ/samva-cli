import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { CliUsageError } from "../errors";

const usage = (code: string, message: string) => new CliUsageError({ code, message });

/**
 * Turn the path a person types into the request target below the configured API URL.
 * `email/domains`, `/email/domains`, and `/v1/email/domains` all reach `/v1/email/domains`.
 * An absolute URL is refused: the command sends Samva credentials, and they go to the
 * configured API URL only.
 */
export const apiRequestPath = (raw: string) => {
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) {
    return Effect.fail(
      usage(
        "api_path_absolute_url",
        "Pass a path such as email/domains, not a URL. Requests go to the configured API URL; use --api-url or a profile to change it.",
      ),
    );
  }
  const trimmed = raw.replace(/^\/+/, "");
  if (trimmed.length === 0 || trimmed.startsWith("?")) {
    return Effect.fail(usage("api_path_missing", "Pass an API path such as email/domains."));
  }
  const first = trimmed.split(/[/?#]/, 1)[0];
  return Effect.succeed(first === "v1" ? `/${trimmed}` : `/v1/${trimmed}`);
};

/** One `key=value` argument from `-f`, `-F`, with `value` absent for a bare `key[]`. */
export interface FieldAssignment {
  readonly key: string;
  readonly value: string | undefined;
}

export const parseFieldAssignment = (raw: string, flag: string) => {
  const separator = raw.indexOf("=");
  if (separator === -1) {
    return raw.endsWith("[]")
      ? Effect.succeed<FieldAssignment>({ key: raw, value: undefined })
      : Effect.fail(usage("api_field_malformed", `${flag} expects key=value, got ${raw}.`));
  }
  const key = raw.slice(0, separator);
  if (key.length === 0) {
    return Effect.fail(usage("api_field_malformed", `${flag} expects key=value, got ${raw}.`));
  }
  return Effect.succeed<FieldAssignment>({ key, value: raw.slice(separator + 1) });
};

/**
 * The `-F` conversion: `true`, `false`, `null`, and canonical integers become JSON values; anything
 * else stays a string. An integer with a leading zero stays a string so identifiers such as `007`
 * survive.
 */
export const typedFieldValue = (value: string): string | number | boolean | null => {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^(0|-?[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return value;
};

type FieldValue = string | number | boolean | null;
interface FieldObject {
  [key: string]: FieldTree;
}
type FieldTree = FieldValue | FieldObject | ReadonlyArray<FieldValue | FieldObject>;

const keyShape = /^([^[\]]+)((?:\[[^[\]]*\])*)$/;

const parseKey = (key: string): { path: ReadonlyArray<string>; array: boolean } | undefined => {
  const match = keyShape.exec(key);
  if (match === null) return undefined;
  const segments = [...(match[2] ?? "").matchAll(/\[([^[\]]*)\]/g)].map((part) => part[1] ?? "");
  const array = segments.at(-1) === "";
  const named = array ? segments.slice(0, -1) : segments;
  if (named.includes("")) return undefined;
  return { path: [match[1] as string, ...named], array };
};

const isFieldObject = (value: FieldTree | undefined): value is FieldObject =>
  Predicate.isObject(value) && !Array.isArray(value);

/**
 * Objects are built without a prototype, so a field named `constructor` or `__proto__` is an
 * ordinary key rather than an inherited one.
 *
 * Assemble `key=value` assignments into a JSON object. `a[b]=v` nests, `a[]=v` appends to an
 * array, and a bare `a[]` creates an empty one. A later assignment to the same scalar key wins; an
 * assignment that would turn an object, array, or scalar into another shape is refused.
 */
export const buildFieldObject = (
  assignments: ReadonlyArray<{ readonly key: string; readonly value: FieldValue | undefined }>,
) =>
  Effect.gen(function* () {
    const root: FieldObject = Object.create(null);
    for (const { key, value } of assignments) {
      const parsed = parseKey(key);
      if (parsed === undefined) {
        return yield* usage(
          "api_field_key_invalid",
          `Field name ${JSON.stringify(key)} is not valid. Use name, name[sub], or name[].`,
        );
      }
      let node = root;
      for (const segment of parsed.path.slice(0, -1)) {
        const next = node[segment];
        if (next === undefined) {
          const created: FieldObject = Object.create(null);
          node[segment] = created;
          node = created;
        } else if (isFieldObject(next)) {
          node = next;
        } else {
          return yield* usage(
            "api_field_conflict",
            `Field ${key} conflicts with an earlier field.`,
          );
        }
      }
      const leaf = parsed.path.at(-1) as string;
      const existing = node[leaf];
      if (parsed.array) {
        if (existing !== undefined && !Array.isArray(existing)) {
          return yield* usage(
            "api_field_conflict",
            `Field ${key} conflicts with an earlier field.`,
          );
        }
        const list: Array<FieldValue | FieldObject> = Array.isArray(existing) ? [...existing] : [];
        if (value !== undefined) list.push(value);
        node[leaf] = list;
      } else {
        if (isFieldObject(existing) || Array.isArray(existing)) {
          return yield* usage(
            "api_field_conflict",
            `Field ${key} conflicts with an earlier field.`,
          );
        }
        node[leaf] = value as FieldValue;
      }
    }
    return root;
  });

/**
 * Query-string pairs for a field object, used when the fields travel in the URL. Arrays repeat the
 * key; nested objects use `key[sub]`.
 */
export const fieldQueryPairs = (
  object: FieldObject,
  prefix?: string,
): ReadonlyArray<readonly [string, string]> =>
  Object.entries(object).flatMap(([name, value]): ReadonlyArray<readonly [string, string]> => {
    const key = prefix === undefined ? name : `${prefix}[${name}]`;
    if (Array.isArray(value)) {
      return value.flatMap((item) =>
        isFieldObject(item) ? fieldQueryPairs(item, key) : [[key, String(item)] as const],
      );
    }
    if (isFieldObject(value)) return fieldQueryPairs(value, key);
    return [[key, String(value)] as const];
  });

/** Parse a `-H key:value` argument. */
export const parseHeader = (raw: string) => {
  const separator = raw.indexOf(":");
  const name = raw.slice(0, separator).trim();
  if (separator === -1 || name.length === 0 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
    return Effect.fail(usage("api_header_malformed", `--header expects key:value, got ${raw}.`));
  }
  return Effect.succeed([name, raw.slice(separator + 1).trim()] as const);
};

const secretHeader = /authorization|api-key|token|secret|cookie/i;

/** Header values the verbose trace must not print. */
export const redactedHeaderValue = (name: string, value: string): string =>
  secretHeader.test(name) ? "<redacted>" : value;

export interface OrderedField {
  readonly typed: boolean;
  readonly flag: "--raw-field" | "--field";
  readonly raw: string;
}

const fieldFlagKinds: Readonly<Record<string, "--raw-field" | "--field">> = {
  "-f": "--raw-field",
  "--raw-field": "--raw-field",
  "-F": "--field",
  "--field": "--field",
};
const optionsWithValue = new Set([
  "-X",
  "--method",
  "-H",
  "--header",
  "--input",
  "--profile",
  "--api-url",
  "--org",
  "--log-level",
]);

/**
 * `-f` and `-F` parse into two lists, which loses the order they were typed in. Later fields win
 * and array elements append in order, so the command line is read again to merge the lists back
 * into that order. A spelling it cannot place (`-fkey=value`) falls back to every `-f` and then
 * every `-F`.
 */
export const orderFields = (
  argv: ReadonlyArray<string>,
  rawFields: ReadonlyArray<string>,
  typedFields: ReadonlyArray<string>,
): ReadonlyArray<OrderedField> => {
  const sequence: Array<"--raw-field" | "--field"> = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] as string;
    if (token === "--") break;
    const kind = fieldFlagKinds[token];
    if (kind !== undefined) {
      sequence.push(kind);
      index++;
    } else if (optionsWithValue.has(token)) {
      index++;
    } else {
      const equals = token.indexOf("=");
      const named = equals === -1 ? undefined : fieldFlagKinds[token.slice(0, equals)];
      if (named !== undefined) sequence.push(named);
    }
  }
  const raw = [...rawFields];
  const typed = [...typedFields];
  const countOf = (kind: string) => sequence.filter((entry) => entry === kind).length;
  const placed = countOf("--raw-field") === raw.length && countOf("--field") === typed.length;
  const kinds: ReadonlyArray<"--raw-field" | "--field"> = placed
    ? sequence
    : [...raw.map(() => "--raw-field" as const), ...typed.map(() => "--field" as const)];
  return kinds.map((flag) => ({
    flag,
    typed: flag === "--field",
    raw: (flag === "--field" ? typed : raw).shift() as string,
  }));
};
