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

const addSubcommands = (
  existing: ReadonlyArray<Command.Command.Any>,
  additions: ReadonlyMap<string, CommandBranch>,
): ReadonlyArray<Command.Command.Any> => {
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
    const children = parent.subcommands.flatMap((group) => group.commands);
    return Command.withSubcommands(parent, addSubcommands(children, node.children));
  };

  return [
    ...existing.map((command) => {
      const node = additions.get(command.name);
      return node === undefined ? command : merge(command.name, node, command);
    }),
    ...Array.from(additions)
      .filter(([name]) => !existing.some((command) => command.name === name))
      .map(([name, node]) => merge(name, node)),
  ];
};

export const addDerivedCommands = (existing: ReadonlyArray<Command.Command.Any>) =>
  addSubcommands(existing, derivedTree.children);
