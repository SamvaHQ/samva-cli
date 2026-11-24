import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import type * as Command from "effect/cli/Command";

import { cli } from "../src/cli";
import { commandPath, idListCommands } from "../src/lib/id-guidance";
import { runCli } from "./support/run-cli";

const paths = (
  command: Command.Command.Any,
  path: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  path.join(" "),
  ...command.subcommands.flatMap(({ commands }) =>
    commands.flatMap((child) => paths(child, [...path, child.name])),
  ),
];

let configHome: string;
beforeAll(async () => {
  configHome = await mkdtemp(join(tmpdir(), "samva-cli-id-"));
});
afterAll(async () => {
  await rm(configHome, { recursive: true, force: true });
});

describe("id guidance", () => {
  it("points every listed prefix at a command that exists", () => {
    const registered = new Set(paths(cli, ["samva"]));
    const missing = Object.entries(idListCommands).filter(
      ([, command]) => !registered.has(commandPath(command).join(" ")),
    );
    expect(missing).toEqual([]);
  });

  it("names the list command when an argument is not an id", async () => {
    const parsed = await runCli(["mailboxes", "get", "support"], { configHome });
    expect(parsed.code).toBe(2);
    expect(parsed.stderr).toContain("Try: samva mailboxes list");

    const encoded = await runCli(["templates", "get", "welcome", "--json"], {
      configHome,
      env: { SAMVA_API_KEY: "samva_sk_test", SAMVA_API_URL: "http://127.0.0.1:9" },
    });
    expect(encoded.code).toBe(1);
    expect(JSON.parse(encoded.stderr)).toMatchObject({
      type: "error",
      next: "samva templates list",
    });
  });
});
