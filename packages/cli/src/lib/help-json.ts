import type * as Command from "effect/cli/Command";
import type * as HelpDoc from "effect/cli/HelpDoc";
import type * as Param from "effect/cli/Param";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

const description = (value: Option.Option<string>): string | null => Option.getOrNull(value);

const flag = (doc: HelpDoc.FlagDoc, metadata?: FlagMetadata) => ({
  name: doc.name,
  aliases: doc.aliases,
  type: doc.type,
  description: description(doc.description),
  required: doc.required && (metadata?.required ?? true),
  repeatable: metadata?.repeatable ?? false,
});

/**
 * The machine-readable form of one command's `--help`: what the command does,
 * its usage line, flags, positional arguments, subcommands, and examples. The
 * result envelope's `command` names the command; this is its `data`.
 */
export const helpDocJson = (doc: HelpDoc.HelpDoc, root: Command.Command.Any) => {
  const metadata = flagMetadataByName(doc, root);
  return {
    schemaVersion: 1,
    description: doc.description,
    usage: doc.usage,
    flags: doc.flags.map((entry) => flag(entry, metadata.get(entry.name))),
    globalFlags: (doc.globalFlags ?? []).map((entry) => flag(entry)),
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
  };
};

interface FlagMetadata {
  readonly name: string;
  readonly required: boolean;
  readonly repeatable: boolean;
}

/** HelpDoc does not retain the occurrence bounds or the fallback of a flag. */
const flagMetadata = (param: Param.Any): FlagMetadata => {
  const node = param as
    | Param.Single<Param.ParamKind, unknown>
    | Param.Map<Param.ParamKind, unknown, unknown>
    | Param.Transform<Param.ParamKind, unknown, unknown>
    | Param.Optional<Param.ParamKind, unknown>
    | Param.Variadic<Param.ParamKind, unknown>;
  if (node._tag === "Single") return { name: node.name, required: true, repeatable: false };
  const inner = flagMetadata(node.param);
  switch (node._tag) {
    case "Map":
      return inner;
    case "Optional":
      return { ...inner, required: false };
    case "Transform":
      return { ...inner, required: node.fallback === undefined && inner.required };
    case "Variadic":
      return {
        ...inner,
        required: Option.exists(node.min, (min) => min > 0),
        repeatable: true,
      };
  }
};

const flagMetadataByName = (doc: HelpDoc.HelpDoc, root: Command.Command.Any) => {
  const command = doc.commandPath === undefined ? undefined : commandAt(root, doc.commandPath);
  const config: unknown = Predicate.hasProperty(command, "config") ? command.config : undefined;
  const flags = Predicate.hasProperty(config, "flags") ? config.flags : undefined;
  return new Map(
    Array.isArray(flags)
      ? (flags as ReadonlyArray<Param.Any>).map((param) => {
          const metadata = flagMetadata(param);
          return [metadata.name, metadata];
        })
      : [],
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
  const metadata = flagMetadataByName(doc, root);
  return {
    ...doc,
    flags: doc.flags.map((entry) =>
      entry.type !== "boolean" && metadata.get(entry.name)?.required === true
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
