import { isatty } from "node:tty";

import * as Flag from "effect/cli/Flag";
import * as Prompt from "effect/cli/Prompt";
import * as Effect from "effect/Effect";

import { CliUsageError } from "../errors";
import { NoInput } from "./runtime";

/** Suffix every `--yes` description carries so help shows where confirmation is mandatory. */
export const YES_REQUIRED_NOTE = "(required outside a terminal)";

/** The `--yes` flag that {@link confirmDestructive} reads; its help says automation must pass it. */
export const yesFlag = (action = "Confirm the destructive action") =>
  Flag.Boolean("yes").pipe(
    Flag.withDescription(`${action} ${YES_REQUIRED_NOTE}`),
    Flag.withDefault(false),
  );

/** Confirm a destructive action in a real TTY; automation must pass --yes. */
export const confirmDestructive = (options: {
  readonly yes: boolean;
  readonly json: boolean;
  readonly message: string;
  readonly nonInteractiveMessage: string;
}) =>
  Effect.gen(function* () {
    if (options.yes) return;
    if ((yield* NoInput) || options.json || !isatty(0) || !isatty(1)) {
      return yield* new CliUsageError({
        code: "confirmation_required",
        message: options.nonInteractiveMessage,
      });
    }
    const confirmed = yield* Prompt.run(
      Prompt.Confirm({ message: options.message, initial: false }),
    );
    if (!confirmed) {
      return yield* new CliUsageError({
        code: "confirmation_declined",
        message: "Cancelled; no changes were made.",
      });
    }
  });
