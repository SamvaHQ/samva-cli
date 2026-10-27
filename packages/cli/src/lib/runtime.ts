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

/** Process-boundary metadata, solely for stable envelope command names. */
const commandTree = {
  login: {},
  logout: {},
  org: { list: {}, use: {}, current: {}, avatar: { set: {}, clear: {} }, usage: {} },
  email: {
    send: {},
    doctor: {},
    receiving: { status: {}, enable: {} },
    review: { status: {}, reapply: {} },
    tracking: {
      defaults: { get: {}, set: {} },
      recipient: { get: {}, set: {} },
    },
    domains: {
      list: {},
      add: {},
      check: {},
      remove: {},
      "rotate-dkim": {},
      "set-default": {},
      "custom-tracking": { enable: {}, status: {}, recheck: {}, disable: {} },
    },
    senders: { list: {}, add: {}, check: {}, "set-default": {}, remove: {} },
  },
  messages: { list: {}, get: {}, events: {}, wait: {} },
  contacts: { list: {}, get: {}, events: {}, import: {}, "import-status": {}, "import-resume": {} },
  events: { send: {} },
  journeys: {
    list: {},
    get: {},
    create: {},
    rename: {},
    draft: {},
    publish: {},
    pause: {},
    resume: {},
    archive: {},
    delete: {},
    version: {},
    stats: {},
    runs: { list: {}, get: {} },
  },
  campaigns: {
    report: {},
    preview: {},
    test: {},
    create: {},
    list: {},
    get: {},
    update: {},
    archive: {},
    runs: { create: {}, list: {}, get: {}, pause: {}, resume: {}, cancel: {}, recipients: {} },
  },
  "scheduled-messages": { create: {}, list: {}, get: {}, cancel: {}, resume: {} },
  templates: {
    init: {},
    clone: {},
    credential: {},
    add: {},
    move: {},
    dev: {},
    check: {},
    render: {},
    snapshot: {},
    build: {},
    export: {},
    types: {},
    workspace: {
      open: {},
      diff: {},
      patch: {},
      "add-asset": {},
      check: {},
      fixture: {},
      save: {},
      history: {},
      publish: {},
    },
    publish: {},
    list: {},
    get: {},
    create: {},
    "from-website": {},
    update: {},
    remove: {},
  },
  brands: { list: {}, get: {}, pull: {}, push: {}, default: {}, remove: {} },
  mailboxes: {
    events: {},
    list: {},
    create: {},
    get: {},
    update: {},
    pause: {},
    resume: {},
    endpoints: { add: {}, update: {}, remove: {} },
    remove: {},
    threads: {},
    read: {},
    send: {},
    reply: {},
    actions: { list: {}, get: {}, approve: {}, deny: {}, cancel: {}, retry: {} },
    quarantine: { list: {}, release: {}, discard: {} },
  },
  namespaces: {
    list: {},
    create: {},
    get: {},
    update: {},
    delete: {},
    assign: {},
    unassign: {},
    usage: {},
  },
  extensions: {
    init: {},
    build: {},
    publish: {},
    dev: {},
    list: {},
    versions: {},
    version: {},
    install: {},
    installations: {},
    installation: {},
    uninstall: {},
    upgrade: {},
    disable: {},
    enable: {},
    runs: {},
    run: {},
  },
  webhooks: {
    list: {},
    get: {},
    secret: {},
    create: {},
    update: {},
    test: {},
    logs: {},
    stats: {},
    retry: {},
    "rotate-secret": {},
    remove: {},
  },
  api: {},
  "api-keys": { list: {}, get: {}, create: {}, update: {}, rotate: {}, revoke: {} },
  profile: { list: {}, show: {}, create: {}, use: {}, delete: {} },
  feedback: { send: {} },
  subscriptions: { subscribe: {} },
  topics: {
    list: {},
    get: {},
    create: {},
    update: {},
    remove: {},
    default: {},
    subscriptions: { list: {}, set: {}, check: {} },
    issues: {
      list: {},
      open: {},
      read: {},
      create: {},
      update: {},
      delete: {},
      save: {},
      check: {},
      render: {},
      head: {},
      history: {},
    },
  },
  help: {},
} as const;

interface CommandTree {
  readonly [name: string]: CommandTree;
}

/** Command handlers remain the grammar authority. */
export const isKnownRootCommand = (token: string): boolean => token in commandTree;

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
    if (path.length === 0) {
      if (token in tree) {
        path.push(token);
        tree = tree[token]!;
      }
      continue;
    }
    if (token in tree) {
      path.push(token);
      tree = tree[token]!;
      continue;
    }
    break;
  }
  return path.length === 0 ? "samva" : path.join(".");
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
