import type * as Command from "effect/cli/Command";
import type * as HelpDoc from "effect/cli/HelpDoc";
import type * as Param from "effect/cli/Param";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

const description = (value: Option.Option<string>): string | null => Option.getOrNull(value);

const flag = (doc: HelpDoc.FlagDoc) => ({
  name: doc.name,
  aliases: doc.aliases,
  type: doc.type,
  description: description(doc.description),
  required: doc.required,
});

/**
 * The machine-readable form of one command's `--help`: what the command does,
 * its usage line, flags, positional arguments, subcommands, and examples. The
 * result envelope's `command` names the command; this is its `data`.
 */
export const helpDocJson = (doc: HelpDoc.HelpDoc) => ({
  schemaVersion: 1,
  description: doc.description,
  usage: doc.usage,
  flags: doc.flags.map(flag),
  globalFlags: (doc.globalFlags ?? []).map(flag),
  args: (doc.args ?? []).map((arg) => ({
    name: arg.name,
    type: arg.type,
    description: description(arg.description),
    required: arg.required,
    variadic: arg.variadic,
  })),
  subcommands: (doc.subcommands ?? []).flatMap((group) =>
    group.commands.map((command) => ({
      name: command.name,
      alias: command.alias ?? null,
      description: command.shortDescription ?? command.description,
      group: group.group ?? null,
    })),
  ),
  examples: (doc.examples ?? []).map((example) => ({
    command: example.command,
    description: example.description ?? null,
  })),
});

/**
 * Whether parsing fails when the flag is absent. The framework's own `required` also counts a
 * repeatable flag (`atLeast(0)`) as required, so text help reads the parameter instead.
 */
const paramRequired = (param: Param.Any): boolean => {
  const node = param as
    | Param.Single<Param.ParamKind, unknown>
    | Param.Map<Param.ParamKind, unknown, unknown>
    | Param.Transform<Param.ParamKind, unknown, unknown>
    | Param.Optional<Param.ParamKind, unknown>
    | Param.Variadic<Param.ParamKind, unknown>;
  switch (node._tag) {
    case "Single":
      return true;
    case "Optional":
      return false;
    case "Map":
      return paramRequired(node.param);
    case "Transform":
      return node.fallback === undefined && paramRequired(node.param);
    case "Variadic":
      return Option.exists(node.min, (min) => min > 0) && paramRequired(node.param);
  }
};

const singleNames = (param: Param.Any): ReadonlyArray<string> => {
  const node = param as {
    readonly _tag: string;
    readonly name?: string;
    readonly param?: Param.Any;
  };
  return node._tag === "Single" && node.name !== undefined
    ? [node.name]
    : node.param === undefined
      ? []
      : singleNames(node.param);
};

/** The flags a command refuses to run without, by name; undefined when they cannot be read. */
const requiredFlagNames = (command: Command.Command.Any): ReadonlySet<string> | undefined => {
  const config: unknown = Predicate.hasProperty(command, "config") ? command.config : undefined;
  const flags: unknown =
    Predicate.hasProperty(config, "flags") && Array.isArray(config.flags)
      ? config.flags
      : undefined;
  if (!Array.isArray(flags)) return undefined;
  return new Set(
    (flags as ReadonlyArray<Param.Any>).flatMap((param) =>
      paramRequired(param) ? singleNames(param) : [],
    ),
  );
};

const commandAt = (
  root: Command.Command.Any,
  path: ReadonlyArray<string>,
): Command.Command.Any | undefined =>
  path
    .slice(1)
    .reduce<Command.Command.Any | undefined>(
      (command, name) =>
        command?.subcommands.flatMap(({ commands }) => commands).find((sub) => sub.name === name),
      root,
    );

/**
 * The help document for text output: a flag the command refuses to run without says so in its
 * description, since the framework's table lists required and optional flags alike. The structured
 * form keeps its own `required` field instead.
 */
export const markRequiredFlags = (
  doc: HelpDoc.HelpDoc,
  root: Command.Command.Any,
): HelpDoc.HelpDoc => {
  const command = doc.commandPath === undefined ? undefined : commandAt(root, doc.commandPath);
  const required = command === undefined ? undefined : requiredFlagNames(command);
  return {
    ...doc,
    flags: doc.flags.map((entry) =>
      entry.type !== "boolean" && required?.has(entry.name) === true
        ? {
            ...entry,
            description: Option.some(
              Option.match(entry.description, {
                onNone: () => "(required)",
                onSome: (text) => `${text} (required)`,
              }),
            ),
          }
        : entry,
    ),
  };
};
