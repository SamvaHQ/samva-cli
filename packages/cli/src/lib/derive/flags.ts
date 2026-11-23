import { Option, SchemaAST } from "effect";
import * as Argument from "effect/cli/Argument";
import * as Flag from "effect/cli/Flag";

export const kebab = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

const fieldAliases: Readonly<Record<string, string>> = {
  namespaceId: "namespace",
  expectedRevision: "revision",
};

const membersOf = (ast: SchemaAST.AST): ReadonlyArray<SchemaAST.AST> =>
  SchemaAST.isUnion(ast) ? ast.types.flatMap(membersOf) : [ast];

const presentMembers = (ast: SchemaAST.AST) =>
  membersOf(ast).filter((member) => !SchemaAST.isUndefined(member) && !SchemaAST.isNull(member));

export const fieldsOf = (ast: SchemaAST.AST) => {
  const fields = new Map<string, Array<SchemaAST.AST>>();
  for (const member of membersOf(SchemaAST.toType(ast))) {
    if (!SchemaAST.isObjects(member)) continue;
    for (const { name, type } of member.propertySignatures) {
      if (typeof name !== "string") continue;
      const types = fields.get(name);
      if (types === undefined) fields.set(name, [...presentMembers(type)]);
      else types.push(...presentMembers(type));
    }
  }
  return fields;
};

const scalar = (members: ReadonlyArray<SchemaAST.AST>) => {
  if (members.length === 0) return undefined;
  if (members.every(SchemaAST.isLiteral)) {
    const literals = new Map(members.map(({ literal }) => [String(literal), literal]));
    return (name: string): Flag.Flag<unknown> =>
      Flag.Literals(name, [...literals.keys()]).pipe(Flag.map((value) => literals.get(value)));
  }
  if (
    members.every(
      (member) =>
        SchemaAST.isString(member) ||
        (SchemaAST.isLiteral(member) && typeof member.literal === "string"),
    )
  )
    return Flag.String;
  if (
    members.every(
      (member) =>
        SchemaAST.isNumber(member) ||
        (SchemaAST.isLiteral(member) && typeof member.literal === "number"),
    )
  )
    return Flag.Finite;
  if (members.every(SchemaAST.isBoolean)) return Flag.Boolean;
  return undefined;
};

export interface FieldFlag {
  readonly field: string;
  readonly flag: Flag.Flag<Option.Option<unknown>>;
}

export const flagOf = (
  field: string,
  members: ReadonlyArray<SchemaAST.AST>,
): FieldFlag | undefined => {
  const name = fieldAliases[field] ?? kebab(field);
  const description = members
    .map(SchemaAST.resolveDescription)
    .find((value) => value !== undefined);
  const described = (flag: Flag.Flag<unknown>) =>
    description === undefined ? flag : Flag.withDescription(flag, description);

  const individual = scalar(members);
  if (individual !== undefined) {
    return { field, flag: Flag.optional(described(individual(name))) };
  }

  const arrays = members.filter(SchemaAST.isArrays);
  if (
    arrays.length === 0 ||
    !members.every(
      (member) =>
        SchemaAST.isArrays(member) ||
        arrays.some((array) => array.rest.some((item) => item._tag === member._tag)),
    )
  )
    return undefined;

  const item = scalar(
    arrays.flatMap((array) => [...array.elements, ...array.rest].flatMap(presentMembers)),
  );
  if (item === undefined) return undefined;
  return {
    field,
    flag: described(item(name)).pipe(
      Flag.atLeast(0),
      Flag.map((values) => (values.length === 0 ? Option.none() : Option.some(values))),
    ),
  };
};

export const argumentOf = (name: string, members: ReadonlyArray<SchemaAST.AST>) => {
  if (members.length > 0 && members.every(SchemaAST.isNumber)) return Argument.Finite(kebab(name));
  return Argument.String(kebab(name));
};
