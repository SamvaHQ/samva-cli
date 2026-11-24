import { publicOperations, type PublicOperation } from "@samva/contracts/surface/operations";
import * as Command from "effect/cli/Command";

import { curatedOverrides } from "../../commands/overrides";
import { deriveCommand } from "./command";
import { kebab } from "./flags";

const groupPaths: Readonly<Record<string, ReadonlyArray<string>>> = {
  organizations: ["org"],
  newsletterIssues: ["newsletters", "issues"],
  newsletterDomains: ["newsletters", "domains"],
  templateRegistrations: ["whatsapp", "templates"],
  whatsappFlows: ["whatsapp", "flows"],
  whatsappSetupLinks: ["whatsapp", "setup-links"],
};

const nameOverrides: Readonly<Record<string, ReadonlyArray<string>>> = {
  "templateRegistrations.list": ["whatsapp", "templates", "registrations"],
};

export const operationCommandPath = (operation: PublicOperation): ReadonlyArray<string> => {
  const claimed = curatedOverrides[operation.operationId];
  if (claimed !== undefined) return claimed.split(" ");
  return (
    nameOverrides[operation.operationId] ?? [
      ...(groupPaths[operation.group] ?? [kebab(operation.group)]),
      kebab(operation.endpoint),
    ]
  );
};

interface CommandBranch {
  operation?: PublicOperation;
  readonly children: Map<string, CommandBranch>;
}

const branch = (): CommandBranch => ({ children: new Map() });

export const derivedOperations = publicOperations().filter(
  ({ operationId }) => !Object.hasOwn(curatedOverrides, operationId),
);

const derivedTree = branch();
for (const operation of derivedOperations) {
  let node = derivedTree;
  for (const name of operationCommandPath(operation)) {
    const child = node.children.get(name) ?? branch();
    node.children.set(name, child);
    node = child;
  }
  node.operation = operation;
}

/** The group that holds derived operations beside a command's hand-written, grouped ones. */
const DERIVED_GROUP = "API operations";

interface Group {
  readonly group: string | undefined;
  readonly commands: ReadonlyArray<Command.Command.Any>;
}

const addSubcommands = (
  groups: ReadonlyArray<Group>,
  additions: ReadonlyMap<string, CommandBranch>,
): ReadonlyArray<Command.Command.SubcommandEntry> => {
  const merge = (
    name: string,
    node: CommandBranch,
    command?: Command.Command.Any,
  ): Command.Command.Any => {
    if (node.operation !== undefined) {
      return command ?? deriveCommand(node.operation, name);
    }
    const parent =
      command ??
      Command.make(name).pipe(Command.withDescription(`Manage ${name.replaceAll("-", " ")}`));
    return Command.withSubcommands(parent, addSubcommands(parent.subcommands, node.children));
  };

  const existing = new Set(groups.flatMap((group) => group.commands.map(({ name }) => name)));
  const added = Array.from(additions)
    .filter(([name]) => !existing.has(name))
    .map(([name, node]) => merge(name, node));
  const merged = groups.map(({ commands }) =>
    commands.map((command) => {
      const node = additions.get(command.name);
      return node === undefined ? command : merge(command.name, node, command);
    }),
  );
  const entries: Array<Command.Command.SubcommandEntry> = [];
  groups.forEach(({ group }, index) => {
    const commands = merged[index] ?? [];
    if (group === undefined) entries.push(...commands);
    else if (commands.length > 0) entries.push({ group, commands });
  });
  const grouped = groups.some(({ group }) => group !== undefined);
  if (added.length === 0) return entries;
  return grouped ? [...entries, { group: DERIVED_GROUP, commands: added }] : [...entries, ...added];
};

/** The root has no groups, so merging into it yields plain commands. */
export const addDerivedCommands = (
  existing: ReadonlyArray<Command.Command.Any>,
): ReadonlyArray<Command.Command.Any> =>
  addSubcommands([{ group: undefined, commands: existing }], derivedTree.children).flatMap(
    (entry) => ("group" in entry ? entry.commands : [entry]),
  );
