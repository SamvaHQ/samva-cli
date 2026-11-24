import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import type * as Command from "effect/cli/Command";
import * as Option from "effect/Option";

import { cli } from "../src/cli";
import { YES_REQUIRED_NOTE } from "../src/lib/confirm";
import { markRequiredFlags } from "../src/lib/help-json";
import { runCli } from "./support/run-cli";

interface Node {
  readonly path: ReadonlyArray<string>;
  readonly command: Command.Command.Any;
}

/** Every command in the tree, with the path `--help` would show for it. */
const walk = (command: Command.Command.Any, path: ReadonlyArray<string>): ReadonlyArray<Node> => [
  { path, command },
  ...command.subcommands.flatMap(({ commands }) =>
    commands.flatMap((child) => walk(child, [...path, child.name])),
  ),
];

const nodes = walk(cli, ["samva"]);

let configHome: string;
beforeAll(async () => {
  configHome = await mkdtemp(join(tmpdir(), "samva-cli-help-"));
});
afterAll(async () => {
  await rm(configHome, { recursive: true, force: true });
});

describe("help text", () => {
  it("describes every subcommand a parent lists", () => {
    const blank = nodes.flatMap(({ path, command }) =>
      (command.buildHelpDoc(path).subcommands ?? []).flatMap(({ commands }) =>
        commands
          .filter((sub) => (sub.shortDescription ?? sub.description).trim() === "")
          .map((sub) => [...path, sub.name].join(" ")),
      ),
    );
    expect(blank).toEqual([]);
  });

  it("marks every --yes as required outside a terminal", () => {
    const unmarked = nodes.flatMap(({ path, command }) =>
      command
        .buildHelpDoc(path)
        .flags.filter((flag) => flag.name === "yes")
        .filter((flag) => !Option.getOrElse(flag.description, () => "").endsWith(YES_REQUIRED_NOTE))
        .map(() => path.join(" ")),
    );
    expect(unmarked).toEqual([]);
    expect(
      nodes.some(({ command, path }) =>
        command.buildHelpDoc(path).flags.some((f) => f.name === "yes"),
      ),
    ).toBe(true);
  });

  it("marks the flags a command refuses to run without, and not repeatable or defaulted ones", () => {
    const marked = (path: ReadonlyArray<string>) => {
      const command = nodes.find((node) => node.path.join(" ") === path.join(" "))?.command;
      if (command === undefined) return expect.fail(`${path.join(" ")} must exist`);
      const doc = markRequiredFlags({ ...command.buildHelpDoc(path), commandPath: path }, cli);
      return doc.flags
        .filter((flag) => Option.getOrElse(flag.description, () => "").endsWith("(required)"))
        .map(({ name }) => name);
    };
    expect(marked(["samva", "mailboxes", "create"])).toEqual(["address", "name"]);
    // `--grant`, `--mailbox` and `--mailbox-permission` repeat from zero; `--commit` defaults.
    expect(marked(["samva", "api-keys", "create"])).toEqual(["name"]);
    expect(marked(["samva", "templates", "publish"])).toEqual([]);
  });

  it("prints required markers in text help, and none in the structured help", async () => {
    const text = await runCli(["mailboxes", "create", "--help"], { configHome });
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toMatch(/--name string\s+Display name for the mailbox \(required\)/);
    const structured = await runCli(["mailboxes", "create", "--help", "--json"], { configHome });
    const flags = JSON.parse(structured.stdout).data.flags as ReadonlyArray<{
      name: string;
      description: string | null;
      required: boolean;
    }>;
    expect(flags.find(({ name }) => name === "name")).toMatchObject({
      description: "Display name for the mailbox",
      required: true,
    });
  });

  it("groups mailboxes help and lists every derived operation under its summary", async () => {
    const result = await runCli(["mailboxes", "--help"], { configHome });
    expect(result.code, result.stderr).toBe(0);
    const headings = result.stdout.split("\n").filter((line) => /^[A-Z][A-Za-z ]+:$/.test(line));
    expect(headings).toEqual(["Everyday:", "Mailbox admin:", "API operations:"]);
    const rows = result.stdout.split("\n").filter((line) => /^ {2}[a-z][a-z-]+ /.test(line));
    expect(rows.every((row) => row.trim().includes(" "))).toBe(true);
    expect(result.stdout).toMatch(/^ {2}reschedule-send\s+Reschedule a mailbox send$/m);
    expect(result.stdout).not.toMatch(/^ {2}[a-z-]+\s*$/m);
    const structured = await runCli(["mailboxes", "--help", "--json"], { configHome });
    const subcommands = JSON.parse(structured.stdout).data.subcommands as ReadonlyArray<{
      name: string;
      description: string;
      group: string | null;
    }>;
    expect(subcommands.find(({ name }) => name === "reschedule-send")).toEqual({
      name: "reschedule-send",
      alias: null,
      description: "Reschedule a mailbox send",
      group: "API operations",
    });
    expect(subcommands.find(({ name }) => name === "list")?.group).toBe("Everyday");
  });
});
