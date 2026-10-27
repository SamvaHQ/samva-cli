import type * as HelpDoc from "effect/cli/HelpDoc";
import * as Option from "effect/Option";

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
