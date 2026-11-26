import type * as Command from "effect/cli/Command";

import { agentsCommand } from "../commands/agents";
import { analyticsCommand } from "../commands/analytics";
import { apiCommand } from "../commands/api";
import { apiKeysCommand } from "../commands/api-keys";
import { brandsCommand } from "../commands/brands";
import { campaignsCommand } from "../commands/campaigns";
import { contactsCommand } from "../commands/contacts";
import { conversationsCommand } from "../commands/conversations";
import { emailCommand } from "../commands/email";
import { eventsCommand } from "../commands/events";
import { feedbackCommand } from "../commands/feedback";
import { journeysCommand } from "../commands/journeys";
import { knowledgeCommand } from "../commands/knowledge";
import { loginCommand } from "../commands/login";
import { logoutCommand } from "../commands/logout";
import { logsCommand } from "../commands/logs";
import { mailboxesCommand } from "../commands/mailboxes";
import { messagesCommand } from "../commands/messages";
import { namespacesCommand } from "../commands/namespaces";
import { newslettersCommand } from "../commands/newsletters";
import { orgCommand } from "../commands/org";
import { policiesCommand } from "../commands/policies";
import { profileCommand } from "../commands/profile";
import { scheduledMessagesCommand } from "../commands/scheduled";
import { subscriptionsCommand } from "../commands/subscriptions";
import { suppressionsCommand } from "../commands/suppressions";
import { templatesCommand } from "../commands/templates";
import { topicsCommand } from "../commands/topics";
import { webhooksCommand } from "../commands/webhooks";
import { whatsappCommand } from "../commands/whatsapp";
import type { deriveCommand } from "./derive/command";
import { isReleasedLeafInvocation, registerCommandTree } from "./runtime";

/** The single root-command registry used by parsing, help, and completions. */
const curatedRootCommands = [
  loginCommand,
  logoutCommand,
  orgCommand,
  emailCommand,
  messagesCommand,
  logsCommand,
  whatsappCommand,
  contactsCommand,
  eventsCommand,
  journeysCommand,
  campaignsCommand,
  suppressionsCommand,
  subscriptionsCommand,
  topicsCommand,
  newslettersCommand,
  scheduledMessagesCommand,
  templatesCommand,
  brandsCommand,
  mailboxesCommand,
  agentsCommand,
  analyticsCommand,
  conversationsCommand,
  knowledgeCommand,
  namespacesCommand,
  webhooksCommand,
  apiCommand,
  apiKeysCommand,
  policiesCommand,
  profileCommand,
  feedbackCommand,
] as const;

type RootServices =
  | Command.Services<(typeof curatedRootCommands)[number]>
  | Command.Services<ReturnType<typeof deriveCommand>>;

registerCommandTree(curatedRootCommands);

// Root help and completions need the full catalog. A released leaf can run on its own.
const derived = isReleasedLeafInvocation(process.argv.slice(2))
  ? undefined
  : await import("./derive/tree");
// Merging trees erases each node's input shape. The resulting handlers come from these two sets.
export const rootCommands = (derived?.addDerivedCommands(curatedRootCommands) ??
  curatedRootCommands) as ReadonlyArray<
  Command.Command<string, never, unknown, unknown, RootServices>
>;

if (derived !== undefined) registerCommandTree(rootCommands);
