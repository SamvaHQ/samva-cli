import { apiCommand } from "../commands/api";
import { apiKeysCommand } from "../commands/api-keys";
import { brandsCommand } from "../commands/brands";
import { campaignsCommand } from "../commands/campaigns";
import { contactsCommand } from "../commands/contacts";
import { emailCommand } from "../commands/email";
import { eventsCommand } from "../commands/events";
import { extensionsCommand } from "../commands/extensions";
import { feedbackCommand } from "../commands/feedback";
import { journeysCommand } from "../commands/journeys";
import { loginCommand } from "../commands/login";
import { logoutCommand } from "../commands/logout";
import { mailboxesCommand } from "../commands/mailboxes";
import { messagesCommand } from "../commands/messages";
import { namespacesCommand } from "../commands/namespaces";
import { orgCommand } from "../commands/org";
import { profileCommand } from "../commands/profile";
import { scheduledMessagesCommand } from "../commands/scheduled";
import { subscriptionsCommand } from "../commands/subscriptions";
import { templatesCommand } from "../commands/templates";
import { topicsCommand } from "../commands/topics";
import { webhooksCommand } from "../commands/webhooks";

/** The single root-command registry used by parsing, help, and completions. */
export const rootCommands = [
  loginCommand,
  logoutCommand,
  orgCommand,
  emailCommand,
  messagesCommand,
  contactsCommand,
  eventsCommand,
  journeysCommand,
  campaignsCommand,
  subscriptionsCommand,
  topicsCommand,
  scheduledMessagesCommand,
  templatesCommand,
  brandsCommand,
  mailboxesCommand,
  namespacesCommand,
  extensionsCommand,
  webhooksCommand,
  apiCommand,
  apiKeysCommand,
  profileCommand,
  feedbackCommand,
] as const;
