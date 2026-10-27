import { isatty } from "node:tty";

import * as Prompt from "effect/cli/Prompt";
import * as Effect from "effect/Effect";

import { CliUsageError } from "../errors";
import { NoInput } from "./runtime";

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
