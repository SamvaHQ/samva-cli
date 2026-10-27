import * as Command from "effect/cli/Command";
import * as Effect from "effect/Effect";

import { SamvaCliError } from "../errors";

// Scaffolded for discoverability; ships after SMS channel proof (cli-sms-post-email).
// Each leaf is written out directly so it can grow into a real implementation in place.

const segments = Command.make("segments").pipe(
  Command.withDescription("Estimate the SMS segment count for a message"),
  Command.withHandler(
    Effect.fnUntraced(function* () {
      return yield* new SamvaCliError({
        message:
          "`samva sms segments` is not implemented yet — ships after SMS channel proof (cli-sms-post-email).",
      });
    }),
  ),
);

const status = Command.make("status").pipe(
  Command.withDescription("Show SMS channel status and active provider"),
  Command.withHandler(
    Effect.fnUntraced(function* () {
      return yield* new SamvaCliError({
        message:
          "`samva sms status` is not implemented yet — ships after SMS channel proof (cli-sms-post-email).",
      });
    }),
  ),
);

const send = Command.make("send").pipe(
  Command.withDescription("Send an SMS"),
  Command.withHandler(
    Effect.fnUntraced(function* () {
      return yield* new SamvaCliError({
        message:
          "`samva sms send` is not implemented yet — ships after SMS channel proof (cli-sms-post-email).",
      });
    }),
  ),
);

const numbersList = Command.make("list").pipe(
  Command.withDescription("List provisioned phone numbers"),
  Command.withHandler(
    Effect.fnUntraced(function* () {
      return yield* new SamvaCliError({
        message:
          "`samva sms numbers list` is not implemented yet — ships after SMS channel proof (cli-sms-post-email).",
      });
    }),
  ),
);

const numbersSearch = Command.make("search").pipe(
  Command.withDescription("Search available phone numbers to purchase"),
  Command.withHandler(
    Effect.fnUntraced(function* () {
      return yield* new SamvaCliError({
        message:
          "`samva sms numbers search` is not implemented yet — ships after SMS channel proof (cli-sms-post-email).",
      });
    }),
  ),
);

const numbersPurchase = Command.make("purchase").pipe(
  Command.withDescription("Purchase a phone number"),
  Command.withHandler(
    Effect.fnUntraced(function* () {
      return yield* new SamvaCliError({
        message:
          "`samva sms numbers purchase` is not implemented yet — ships after SMS channel proof (cli-sms-post-email).",
      });
    }),
  ),
);

const numbersRelease = Command.make("release").pipe(
  Command.withDescription("Release a provisioned phone number"),
  Command.withHandler(
    Effect.fnUntraced(function* () {
      return yield* new SamvaCliError({
        message:
          "`samva sms numbers release` is not implemented yet — ships after SMS channel proof (cli-sms-post-email).",
      });
    }),
  ),
);

const numbers = Command.make("numbers").pipe(
  Command.withDescription("Manage SMS phone numbers"),
  Command.withSubcommands([numbersList, numbersSearch, numbersPurchase, numbersRelease]),
);

const messageStatus = Command.make("status").pipe(
  Command.withDescription("Check the delivery status of an SMS message"),
  Command.withHandler(
    Effect.fnUntraced(function* () {
      return yield* new SamvaCliError({
        message:
          "`samva sms message status` is not implemented yet — ships after SMS channel proof (cli-sms-post-email).",
      });
    }),
  ),
);

const message = Command.make("message").pipe(
  Command.withDescription("Inspect SMS messages"),
  Command.withSubcommands([messageStatus]),
);

const webhooksTest = Command.make("test").pipe(
  Command.withDescription("Send a synthetic customer webhook event"),
  Command.withHandler(
    Effect.fnUntraced(function* () {
      return yield* new SamvaCliError({
        message:
          "`samva sms webhooks test` is not implemented yet — ships after SMS channel proof (cli-sms-post-email).",
      });
    }),
  ),
);

const webhooks = Command.make("webhooks").pipe(
  Command.withDescription("Test SMS customer webhooks"),
  Command.withSubcommands([webhooksTest]),
);

const proofLocal = Command.make("local").pipe(
  Command.withDescription("Run the local SMS proof checklist"),
  Command.withHandler(
    Effect.fnUntraced(function* () {
      return yield* new SamvaCliError({
        message:
          "`samva sms proof local` is not implemented yet — ships after SMS channel proof (cli-sms-post-email).",
      });
    }),
  ),
);

const proofProduction = Command.make("production").pipe(
  Command.withDescription("Run the production SMS proof checklist"),
  Command.withHandler(
    Effect.fnUntraced(function* () {
      return yield* new SamvaCliError({
        message:
          "`samva sms proof production` is not implemented yet — ships after SMS channel proof (cli-sms-post-email).",
      });
    }),
  ),
);

const proof = Command.make("proof").pipe(
  Command.withDescription("Guided SMS proof runners"),
  Command.withSubcommands([proofLocal, proofProduction]),
);

export const smsCommand = Command.make("sms").pipe(
  Command.withDescription("SMS — scaffolded; ships after SMS channel proof (cli-sms-post-email)"),
  Command.withSubcommands([segments, status, send, numbers, message, webhooks, proof]),
);
