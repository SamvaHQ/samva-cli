import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { AGENT_AUTH_HINT } from "./lib/examples";
import { helpManifest } from "./lib/help-manifest";
import { printJson } from "./lib/output";
import { rootCommands } from "./lib/root-commands";
import { globalFlags, Json, JsonLines, Quiet } from "./lib/runtime";

// Every `Command.withHandler` body across the CLI is `Effect.fnUntraced`. A handler is the process:
// it runs once, prints, and exits, so a span would name the run rather than a step inside it, and
// the CLI installs no tracer to receive one. Reusable work that outlives one call still carries a
// name, as `CliConfig.writeConfig` in `src/config/store.ts` does.
const helpCommand = Command.make("help", {
  topic: Argument.String("topic").pipe(Argument.optional),
}).pipe(
  Command.withDescription("Describe released commands and global options"),
  Command.withHandler(
    Effect.fnUntraced(function* () {
      const json = yield* Json;
      if (json || (yield* JsonLines)) return yield* printJson(helpManifest);
      if (yield* Quiet) return;
      yield* Console.log(
        "Run `samva <command> --help` for command-specific usage, or `samva --completions <bash|zsh|fish|sh>` for shell completions.",
      );
    }),
  ),
);

/** Root `samva` command. Subcommands are thin wrappers over the `samva` SDK. */
export const cli = Command.make("samva").pipe(
  Command.withDescription(
    `Samva — email and platform operations from your terminal. ${AGENT_AUTH_HINT}`,
  ),
  Command.withExamples([
    {
      command: "samva email send --to you@example.com --subject Hi --text Hello",
      description: "Send email with SAMVA_API_KEY set",
    },
    {
      command: "samva org current",
      description: "Show active org (OAuth sessions; API keys are single-org)",
    },
    {
      command: "samva --completions fish > ~/.config/fish/completions/samva.fish",
      description: "Generate shell completions",
    },
  ]),
  Command.withSubcommands([...rootCommands, helpCommand]),
  Command.withGlobalFlags(globalFlags),
);
