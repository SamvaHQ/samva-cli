import { rootCommands } from "./root-commands";

export const helpManifest = {
  schemaVersion: 1,
  name: "samva",
  commands: [...rootCommands.map((command) => command.name), "help"],
  globalOptions: [
    "--json",
    "--jsonl",
    "--quiet",
    "--profile",
    "--api-url",
    "--org",
    "--no-input",
    "--completions",
  ],
} as const;
