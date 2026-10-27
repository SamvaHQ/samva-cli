/** Test-only root for the staged WhatsApp family, which the released root does not mount. */
import { Command } from "effect/cli";

import { whatsappCommand } from "../src/commands/whatsapp";
import { globalFlags } from "../src/lib/runtime";
import { runCli } from "../src/run";

const cli = Command.make("samva").pipe(
  Command.withSubcommands([whatsappCommand]),
  Command.withGlobalFlags(globalFlags),
);

runCli(cli);
