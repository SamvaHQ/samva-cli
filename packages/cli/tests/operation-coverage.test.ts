import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "@effect/vitest";

// oxlint-disable-next-line samva/no-cross-package-relative-imports -- the operation map is an SDK source file, not a package export
import { SDK_EFFECT_MODULES, SDK_SERVICE_OPERATIONS } from "../../sdk/src/service-map";
import { rootCommands } from "../src/lib/root-commands";
import { curatedCommands, OPERATION_COVERAGE } from "./support/operation-coverage";

// Every public API operation is reachable through `samva api`. This table records which ones also
// have a curated command. Other generated operations use the generic API command.

interface CommandNode {
  readonly name: string;
  readonly subcommands: ReadonlyArray<{ readonly commands: ReadonlyArray<CommandNode> }>;
}

const leafPaths = (node: CommandNode, prefix: ReadonlyArray<string>): Array<string> => {
  const path = [...prefix, node.name];
  const children = node.subcommands.flatMap((group) => group.commands);
  return children.length === 0 ? [path.join(" ")] : children.flatMap((c) => leafPaths(c, path));
};
const commandPaths = new Set(
  (rootCommands as ReadonlyArray<CommandNode>).flatMap((command) => leafPaths(command, [])),
);

const sdkOperations = new Map<string, Array<string>>();
for (const [service, operations] of Object.entries(SDK_SERVICE_OPERATIONS)) {
  for (const [method, operationId] of Object.entries(operations)) {
    sdkOperations.set(operationId, [
      ...(sdkOperations.get(operationId) ?? []),
      `${service}.${method}`,
    ]);
  }
}

/** Operations a command calls only to read back the result of its own write, never as its purpose. */
const READBACK_ONLY = new Set(["emailGetDomainById"]);

const operationsForModule = (module: string): Readonly<Record<string, string>> => {
  const mapping: Readonly<Record<string, string>> = SDK_EFFECT_MODULES;
  const service = mapping[module];
  if (service === undefined) throw new Error(`Unknown SDK Effect module: ${module}`);
  const services: Readonly<Record<string, Readonly<Record<string, string>>>> =
    SDK_SERVICE_OPERATIONS;
  const operations = services[service];
  if (operations === undefined) throw new Error(`Unknown SDK service: ${service}`);
  return operations;
};

describe("CLI operation coverage", () => {
  it("resolves generated module names and rejects unknown imports", () => {
    expect(operationsForModule("whatsapp")).toBe(SDK_SERVICE_OPERATIONS.whatsapp);
    expect(operationsForModule("whatsapp-flows")).toBe(SDK_SERVICE_OPERATIONS.whatsappFlows);
    expect(operationsForModule("whatsapp-setup-links")).toBe(
      SDK_SERVICE_OPERATIONS.whatsappSetupLinks,
    );
    expect(() => operationsForModule("unknown-module")).toThrow(
      "Unknown SDK Effect module: unknown-module",
    );
  });
  it("keeps curated overrides tied to generated operations", () => {
    const stale = Object.keys(curatedCommands).filter((id) => !sdkOperations.has(id));
    expect(stale, "Remove curated overrides for operations the SDK no longer has.").toEqual([]);
  });

  it("names only commands that exist", () => {
    const missing = Object.entries(OPERATION_COVERAGE).filter(
      ([, command]) => command !== "api" && !commandPaths.has(command),
    );
    expect(
      missing,
      "A covering command must be a leaf path in the command tree, such as `email domains list`.",
    ).toEqual([]);
  });

  it("marks no operation api that a command calls through the SDK", () => {
    const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
    const files = (dir: string): Array<string> =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? files(join(dir, entry.name))
          : entry.name.endsWith(".ts")
            ? [join(dir, entry.name)]
            : [],
      );
    const called = new Set<string>();
    for (const file of files(sourceRoot)) {
      const source = readFileSync(file, "utf8");
      for (const [, alias, module] of source.matchAll(
        /import \* as (\w+) from "samva\/effect\/([\w-]+)"/g,
      )) {
        // Client configures transport; it does not expose an operation group.
        if (module === "client") continue;
        const operations = operationsForModule(module!);
        for (const [, method] of source.matchAll(new RegExp(`\\b${alias}\\.(\\w+)\\b`, "g"))) {
          const operationId = operations[method as string];
          if (operationId !== undefined) called.add(operationId);
        }
      }
    }
    const stale = [...called].filter(
      (id) => OPERATION_COVERAGE[id] === "api" && !READBACK_ONLY.has(id),
    );
    expect(
      stale,
      "A command calls these operations; point each at its command in tests/support/operation-coverage.ts.",
    ).toEqual([]);
    expect(called.size).toBeGreaterThan(100);
  });
});
