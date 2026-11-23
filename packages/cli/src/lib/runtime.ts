import * as Flag from "effect/cli/Flag";
import * as GlobalFlag from "effect/cli/GlobalFlag";
import * as Effect from "effect/Effect";

import { CliUsageError } from "../errors";

/** Process-wide output and execution settings. */
export const Json = GlobalFlag.Setting("json")({
  flag: Flag.Boolean("json").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Output machine-readable JSON"),
  ),
});

export const JsonLines = GlobalFlag.Setting("jsonl")({
  flag: Flag.Boolean("jsonl").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Output newline-delimited JSON result envelopes"),
  ),
});

export const Quiet = GlobalFlag.Setting("quiet")({
  flag: Flag.Boolean("quiet").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Suppress all successful output"),
  ),
});

export const Profile = GlobalFlag.Setting("profile")({
  flag: Flag.String("profile").pipe(
    Flag.optional,
    Flag.withDescription("Execution profile (overrides SAMVA_PROFILE and the active profile)"),
  ),
});

export const ApiUrl = GlobalFlag.Setting("api-url")({
  flag: Flag.String("api-url").pipe(
    Flag.optional,
    Flag.withDescription("Explicit API URL (development/E2E escape hatch)"),
  ),
});

export const Org = GlobalFlag.Setting("org")({
  flag: Flag.String("org").pipe(
    Flag.optional,
    Flag.withDescription("Organization slug for OAuth profiles"),
  ),
});

export const NoInput = GlobalFlag.Setting("no-input")({
  flag: Flag.Boolean("no-input").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Never prompt or open a browser"),
  ),
});

export const globalFlags = [Json, JsonLines, Quiet, Profile, ApiUrl, Org, NoInput] as const;

export type OutputMode = "human" | "json" | "jsonl" | "quiet";

const outputFlags = new Set(["--json", "--jsonl", "--quiet"]);
const outputAssignments = /^(--json|--jsonl|--quiet)=/;

interface CommandNode {
  readonly name: string;
  readonly subcommands: ReadonlyArray<{ readonly commands: ReadonlyArray<CommandNode> }>;
}

type CommandTree = ReadonlyMap<string, CommandTree>;

const commandTreeOf = (commands: ReadonlyArray<CommandNode>): CommandTree =>
  new Map(
    commands.map(({ name, subcommands }) => [
      name,
      commandTreeOf(subcommands.flatMap((group) => group.commands)),
    ]),
  );

let commandTree: CommandTree = new Map();

/** Use the parser's tree for process result names and lazy command registration. */
export const registerCommandTree = (commands: ReadonlyArray<CommandNode>): void => {
  commandTree = new Map([...commandTreeOf(commands), ["help", new Map()]]);
};

export const isKnownRootCommand = (token: string): boolean => commandTree.has(token);

// These paths released with their parent's envelope name. Keep existing scripts and help stable.
const releasedEnvelopeNames: Readonly<Record<string, string>> = {
  "mailboxes.threads.delete": "mailboxes.threads",
  "mailboxes.trash": "mailboxes",
  "mailboxes.trash.empty": "mailboxes",
};

const globalOptionsWithValue = new Set(["--profile", "--api-url", "--org", "--log-level"]);

/**
 * Return the released command path in its stable dotted form. This only reads
 * tokens before `--`; positional data after a recognized leaf never becomes
 * command metadata.
 */
export const commandNameFromArgv = (argv: ReadonlyArray<string>): string => {
  let tree: CommandTree = commandTree;
  const path: Array<string> = [];
  const tokens = argv.values();
  for (const token of tokens) {
    if (token === "--") break;
    if (globalOptionsWithValue.has(token)) {
      tokens.next();
      continue;
    }
    if (
      token.startsWith("--profile=") ||
      token.startsWith("--api-url=") ||
      token.startsWith("--org=") ||
      token.startsWith("--log-level=")
    )
      continue;
    if (token.startsWith("-")) continue;
    const next = tree.get(token);
    if (next === undefined) {
      if (path.length === 0) continue;
      break;
    }
    path.push(token);
    tree = next;
  }
  const name = path.length === 0 ? "samva" : path.join(".");
  return Object.hasOwn(releasedEnvelopeNames, name) ? (releasedEnvelopeNames[name] ?? name) : name;
};

/** Commands with no subcommands can parse and run without the derived catalog. */
export const isReleasedLeafInvocation = (argv: ReadonlyArray<string>): boolean => {
  if (argv.some((arg) => arg === "--completions" || arg.startsWith("--completions="))) return false;
  const name = commandNameFromArgv(argv);
  if (name === "samva" || name === "help") return false;
  let node = commandTree;
  for (const part of name.split(".")) {
    const child = node.get(part);
    if (child === undefined) return false;
    node = child;
  }
  return node.size === 0;
};

/**
 * Validate the tiny set of process-wide syntax rules before Effect CLI begins
 * parsing command-local flags. Stops at `--`, so a positional value cannot
 * accidentally select machine mode.
 */
export const validateProcessArgs = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const selected = new Set<string>();
    for (const token of argv) {
      if (token === "--") break;
      if (outputAssignments.test(token)) {
        return yield* new CliUsageError({
          message: "Use --json, --jsonl, or --quiet without =true or =false.",
          code: "invalid_output_mode_syntax",
        });
      }
      if (outputFlags.has(token)) selected.add(token);
    }
    if (selected.size > 1) {
      return yield* new CliUsageError({
        message: "Use only one of --json, --jsonl, or --quiet.",
        code: "mutually_exclusive_output_mode",
      });
    }
  });

export const outputModeFromArgv = (argv: ReadonlyArray<string>): OutputMode => {
  let selected: OutputMode = "human";
  for (const token of argv) {
    if (token === "--") break;
    if (token === "--jsonl" || token.startsWith("--jsonl=")) selected = "jsonl";
    else if (token === "--json" || token.startsWith("--json=")) {
      if (selected !== "jsonl") selected = "json";
    } else if (token === "--quiet" || token.startsWith("--quiet=")) {
      if (selected === "human") selected = "quiet";
    }
  }
  return selected;
};

export const isJsonRequested = () => outputModeFromArgv(process.argv.slice(2)) === "json";

export const isJsonLinesRequested = () => outputModeFromArgv(process.argv.slice(2)) === "jsonl";
