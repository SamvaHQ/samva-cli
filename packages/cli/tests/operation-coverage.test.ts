import { describe, expect, it } from "@effect/vitest";
import { publicOperations } from "@samva/contracts/surface/operations";

import { curatedOverrides } from "../src/commands/overrides";
import { derivedOperations, operationCommandPath } from "../src/lib/derive/tree";
import { rootCommands } from "../src/lib/root-commands";
import { commandNameFromArgv } from "../src/lib/runtime";
import curatedHelp from "./support/curated-help-baseline.json";

interface CommandNode {
  readonly name: string;
  readonly subcommands: ReadonlyArray<{ readonly commands: ReadonlyArray<CommandNode> }>;
}

const runnablePaths = (node: CommandNode, prefix: ReadonlyArray<string>): Array<string> => {
  const path = [...prefix, node.name];
  const children = node.subcommands.flatMap((group) => group.commands);
  const joined = path.join(" ");
  // The thread-list command runs directly and also hosts a delete subcommand.
  const runnable = children.length === 0 || joined === "mailboxes threads" ? [joined] : [];
  return [...runnable, ...children.flatMap((child) => runnablePaths(child, path))];
};

const paths = rootCommands.flatMap((command) => runnablePaths(command, []));
const operations = publicOperations();
const derivedPaths = derivedOperations.map((operation) =>
  operationCommandPath(operation).join(" "),
);

describe("CLI operation coverage", () => {
  it("registers a runnable path for every public operation", () => {
    const missing = operations.flatMap((operation) => {
      const path = operationCommandPath(operation);
      return paths.includes(path.join(" ")) ? [] : [operation.operationId];
    });
    expect(missing).toEqual([]);
  });

  it("gives each derived operation its own path alongside released commands", () => {
    expect(new Set(derivedPaths).size).toBe(derivedOperations.length);
    expect(
      derivedPaths.filter(
        (path) => commandNameFromArgv(path.split(" ")) !== path.replaceAll(" ", "."),
      ),
    ).toEqual([]);
    expect(derivedPaths.filter((path) => Object.hasOwn(curatedHelp, path))).toEqual([]);
    expect(paths.length).toBe(new Set(paths).size);
  });

  it("ties every curated override to an existing public operation and released command", () => {
    const ids = new Set(operations.map(({ operationId }) => operationId));
    const stale = Object.entries(curatedOverrides).filter(
      ([id, path]) => !ids.has(id) || !Object.hasOwn(curatedHelp, path),
    );
    expect(stale).toEqual([]);
  });
});
