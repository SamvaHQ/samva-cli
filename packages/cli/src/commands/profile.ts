import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { Keyring } from "../config/credential-store";
import {
  readConfig,
  resolveExecutionContext,
  validateProfileName,
  writeConfig,
} from "../config/store";
import { CliUsageError } from "../errors";
import { confirmDestructive } from "../lib/confirm";
import { printJson, printResult } from "../lib/output";
import { Json, JsonLines } from "../lib/runtime";

const list = Command.make("list").pipe(
  Command.withDescription("List user-level execution profiles"),
  Command.withHandler(
    Effect.fnUntraced(function* () {
      const config = yield* readConfig;
      if ((yield* Json) || (yield* JsonLines)) {
        return yield* printJson({
          activeProfile: config.activeProfile ?? "default",
          profiles: config.profiles,
        });
      }
      const active = config.activeProfile ?? "default";
      const lines = Object.entries(config.profiles).map(
        ([name, profile]) =>
          `${name === active ? "* " : "  "}${name}${profile.orgSlug ? `\t${profile.orgSlug}` : ""}`,
      );
      yield* Console.log(
        lines.length > 0 ? lines.join("\n") : "No profiles yet. Use `samva profile create <name>`.",
      );
    }),
  ),
);

const show = Command.make("show", { name: Argument.String("name").pipe(Argument.optional) }).pipe(
  Command.withDescription("Show the resolved execution context"),
  Command.withHandler(
    Effect.fnUntraced(function* ({ name }) {
      const context = yield* resolveExecutionContext;
      const selected = Option.getOrUndefined(name) ?? context.profile;
      const config = yield* readConfig;
      const profile = config.profiles[selected];
      if (!profile && selected !== "default") {
        return yield* new CliUsageError({
          code: "unknown_profile",
          message: `Profile ${selected} does not exist.`,
        });
      }
      const selectedProfile = profile ?? { credentialIdentity: "none" as const };
      const output = {
        name: selected,
        ...selectedProfile,
        apiUrl: selected === context.profile ? context.apiUrl : undefined,
      };
      if ((yield* Json) || (yield* JsonLines)) return yield* printJson(output);
      yield* Console.log(`${output.name}${output.orgSlug ? `\t${output.orgSlug}` : ""}`);
    }),
  ),
);

const create = Command.make("create", {
  name: Argument.String("name"),
  org: Flag.String("org").pipe(Flag.optional),
}).pipe(
  Command.withDescription("Create a non-secret execution profile"),
  Command.withHandler(
    Effect.fnUntraced(function* ({ name, org }) {
      yield* validateProfileName(name);
      const config = yield* readConfig;
      if (config.profiles[name]) {
        return yield* new CliUsageError({
          code: "profile_exists",
          message: `Profile ${name} already exists. Delete it first or choose another name.`,
        });
      }
      const orgSlug = Option.getOrUndefined(org);
      yield* writeConfig({
        ...config,
        profiles: { ...config.profiles, [name]: { orgSlug, credentialIdentity: "none" } },
      });
      yield* printResult({ action: "profile.create", name, orgSlug }, `Created profile ${name}.`);
    }),
  ),
);

const use = Command.make("use", { name: Argument.String("name") }).pipe(
  Command.withDescription("Select the active user-level execution profile"),
  Command.withHandler(
    Effect.fnUntraced(function* ({ name }) {
      const config = yield* readConfig;
      if (!config.profiles[name]) {
        return yield* new CliUsageError({
          code: "unknown_profile",
          message: `Profile ${name} does not exist. Create it with \`samva profile create ${name}\`.`,
        });
      }
      yield* writeConfig({ ...config, activeProfile: name });
      yield* printResult({ action: "profile.use", name }, `Active profile set to ${name}.`);
    }),
  ),
);

const remove = Command.make("delete", {
  name: Argument.String("name"),
  yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withDescription("Delete a profile and its OS-keyring credential"),
  Command.withHandler(
    Effect.fnUntraced(function* ({ name, yes }) {
      const config = yield* readConfig;
      const profile = config.profiles[name];
      if (!profile) {
        return yield* new CliUsageError({
          code: "unknown_profile",
          message: `Profile ${name} does not exist.`,
        });
      }
      const machine = (yield* Json) || (yield* JsonLines);
      yield* confirmDestructive({
        yes,
        json: machine,
        message: `Delete profile ${name} and its saved credential?`,
        nonInteractiveMessage: "Profile deletion requires --yes in non-interactive mode.",
      });
      const { [name]: _, ...profiles } = config.profiles;
      yield* writeConfig(
        config.activeProfile === name ? { version: 2, profiles } : { ...config, profiles },
      );
      if (profile.credentialIdentity === "oauth") yield* (yield* Keyring.Service).clear(name);
      yield* printResult({ action: "profile.delete", name }, `Deleted profile ${name}.`);
    }),
  ),
);

export const profileCommand = Command.make("profile").pipe(
  Command.withDescription("Manage user-level credential identity and organization contexts"),
  Command.withSubcommands([list, show, create, use, remove]),
);
