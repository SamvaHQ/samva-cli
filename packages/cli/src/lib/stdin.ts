import { readFile } from "node:fs";
import { isatty } from "node:tty";
import { promisify } from "node:util";

import * as Effect from "effect/Effect";

import { SamvaCliError } from "../errors";

/**
 * Read piped stdin as UTF-8 (fd 0). Fails fast when stdin is a TTY (no pipe).
 *
 * The rest of this package reads files through `FileSystem.FileSystem`. This one
 * stays on `node:fs` because every FileSystem read takes a path, and
 * there is no path for the already-open descriptor a pipe hands this process.
 */
export const readStdinUtf8 = Effect.gen(function* () {
  if (isatty(0)) {
    return yield* new SamvaCliError({
      message:
        "Expected piped stdin for `-`; redirect input (e.g. `echo … | samva …`) or pass the body inline instead of `-`.",
    });
  }
  return yield* Effect.tryPromise({
    try: () => promisify(readFile)(0, "utf8"),
    catch: () => new SamvaCliError({ message: "Could not read stdin." }),
  });
});
