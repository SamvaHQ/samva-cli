import { AgentName } from "@samva/core/agents/definition";
import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { CliResultError, SamvaCliError } from "../errors";
import { buildAgent, initAgent } from "../lib/agent-project";
import { jsonFlag, printFields, printJson } from "../lib/output";

const directory = Argument.String("dir").pipe(Argument.withDefault("."));
const projectFlags = {
  dir: directory,
  entry: Flag.String("entry").pipe(Flag.withDefault("agent.ts")),
  json: jsonFlag,
};

const init = Command.make("init", {
  dir: directory,
  name: Flag.String("name").pipe(Flag.withSchema(AgentName)),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Scaffold an agent with explicit imports, a tool, a Markdown skill, and an eval",
  ),
  Command.withExamples([{ command: 'samva agents init ./support --name "Support"' }]),
  Command.withHandler(({ dir, name, json }) =>
    Effect.gen(function* () {
      const result = yield* initAgent(dir, name);
      if (json) return yield* printJson(result);
      yield* printFields([
        ["Directory", result.directory],
        ["Name", name],
        ["Files", result.files.join(", ")],
      ]);
      yield* Console.log(
        "Run bun install in that directory, then samva agents build. Edit agent.ts to register tools, events, skills, and schedules.",
      );
    }),
  ),
);

const build = Command.make("build", {
  ...projectFlags,
  out: Flag.String("out").pipe(Flag.withDefault("dist/agent.js")),
}).pipe(
  Command.withDescription(
    "Bundle one self-contained ES module and evaluate its declaration locally to validate its manifest",
  ),
  Command.withExamples([{ command: "samva agents build ./support --entry agent.ts --json" }]),
  Command.withHandler(({ dir, entry, out, json }) =>
    Effect.gen(function* () {
      const { bundle: _bundle, ...result } = yield* buildAgent(dir, entry, out);
      if (json) return yield* printJson(result);
      yield* printFields([
        ["Name", result.manifest.name],
        ["Version", result.manifest.version],
        ["Size", `${result.sizeBytes} bytes`],
        ["SHA256", result.sha256],
        ["Output", result.output],
      ]);
    }),
  ),
);

const info = Command.make("info", projectFlags).pipe(
  Command.withDescription(
    "Inspect the explicit agent entry and report coded diagnostics; evaluates the declaration locally and writes no bundle",
  ),
  Command.withExamples([{ command: "samva agents info ./support --json" }]),
  Command.withHandler(({ dir, entry, json }) =>
    Effect.gen(function* () {
      const inspected = yield* buildAgent(dir, entry).pipe(Effect.result);
      if (inspected._tag === "Failure") {
        const error = inspected.failure;
        const result = {
          entry,
          diagnostics: [
            {
              code:
                error instanceof SamvaCliError
                  ? (error.details?.code ?? "agent_project_failed")
                  : "agent_project_failed",
              message: error.message,
            },
          ],
        };
        return yield* new CliResultError({
          code: "agent_project_invalid",
          message: "Agent project has diagnostics.",
          result,
          human: result.diagnostics
            .map((diagnostic) => `[${diagnostic.code}] ${diagnostic.message}`)
            .join("\n"),
        });
      }
      const { bundle: _bundle, ...result } = inspected.success;
      if (json) return yield* printJson(result);
      yield* printFields([
        ["Entry", result.entry],
        ["Name", result.manifest.name],
        ["Version", result.manifest.version],
        ["Tools", Object.keys(result.manifest.tools).join(", ") || "none"],
        ["Skills", result.manifest.skills.join(", ") || "none"],
        ["Events", result.manifest.events.join(", ") || "none"],
        ["Schedules", result.manifest.schedules.join(", ") || "none"],
        ["SHA256", result.sha256],
        ["Diagnostics", "none"],
      ]);
      for (const [name, tool] of Object.entries(result.manifest.tools))
        yield* printFields([
          ["Tool", name],
          ["Description", tool.description],
          ["Replay", tool.replay],
          [
            "Approval",
            tool.approval === undefined ? "policy floors" : JSON.stringify(tool.approval),
          ],
          ["Input", JSON.stringify(tool.input)],
        ]);
    }),
  ),
);

export const agentProjectCommands = [init, build, info];
