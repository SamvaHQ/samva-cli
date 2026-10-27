import * as Command from "effect/cli/Command";

import { doctorCommand } from "./email/doctor";
import { domainsCommand } from "./email/domains";
import { receivingCommand } from "./email/receiving";
import { reviewCommand } from "./email/review";
import { send } from "./email/send";
import { sendersCommand } from "./email/senders";
import { trackingCommand } from "./email/tracking";

export const emailCommand = Command.make("email").pipe(
  Command.withDescription("Send, inspect, and configure email"),
  Command.withExamples([
    {
      command: "samva email send --to you@example.com --subject Hi --text Hello",
      description: "Send a plain-text email",
    },
    {
      command: "samva email doctor",
      description: "Inspect read-only email readiness",
    },
  ]),
  Command.withSubcommands([
    send,
    doctorCommand,
    receivingCommand,
    reviewCommand,
    domainsCommand,
    sendersCommand,
    trackingCommand,
  ]),
);
