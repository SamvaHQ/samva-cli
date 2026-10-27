import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { HOME, XDG_CONFIG_HOME } from "../env";
import { SamvaCliError } from "../errors";

/**
 * Absolute path to the Samva CLI config directory:
 * `$XDG_CONFIG_HOME/samva` when set, otherwise `~/.config/samva`.
 */
export const configDir = Effect.gen(function* () {
  const path = yield* Path.Path;
  const base =
    XDG_CONFIG_HOME && XDG_CONFIG_HOME.length > 0
      ? XDG_CONFIG_HOME
      : HOME && HOME.length > 0
        ? path.join(HOME, ".config")
        : yield* new SamvaCliError({
            message:
              "Could not resolve config directory. Set XDG_CONFIG_HOME, HOME, or USERPROFILE.",
          });
  return path.join(base, "samva");
});

/** Path to `config.json` (api url + active org). */
export const configFilePath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const dir = yield* configDir;
  return path.join(dir, "config.json");
});
