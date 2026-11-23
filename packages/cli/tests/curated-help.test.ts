import { createHash } from "node:crypto";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import * as CliOutput from "effect/cli/CliOutput";
import * as Command from "effect/cli/Command";
import { TestConsole } from "effect/testing";

import { cli } from "../src/cli";
import { Keyring } from "../src/config/credential-store";
import { helpDocJson } from "../src/lib/help-json";
import { resultEnvelope } from "../src/lib/output";
import { commandNameFromArgv } from "../src/lib/runtime";
import baseline from "./support/curated-help-baseline.json";

const digest = (doc: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(doc, (_key, value: unknown) =>
        Predicate.isObject(value) && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            )
          : value,
      ),
    )
    .digest("hex");

// The base native binary supplied each released command's full --help --json envelope.
describe("released command help", () => {
  it.effect.each(Object.entries(baseline))("%s retains its structured help", ([path, expected]) =>
    Effect.gen(function* () {
      const args = path.split(" ");
      const actual: Array<unknown> = [];
      yield* Command.runWith(cli, { version: "0.0.0" })([...args, "--help", "--json"]).pipe(
        Effect.provide(
          CliOutput.layer({
            ...CliOutput.defaultFormatter(),
            formatHelpDoc: (doc) => {
              actual.push(resultEnvelope(commandNameFromArgv(args), helpDocJson(doc)));
              return "";
            },
          }),
        ),
      );
      expect(actual).toHaveLength(1);
      expect(digest(actual[0])).toBe(expected);
    }).pipe(Effect.provide([BunServices.layer, Keyring.layer, TestConsole.layer])),
  );
});
