import { Console, Effect } from "effect";
import type * as Mailboxes from "samva/effect/mailboxes";

import { skippedRecipientsLine } from "../commands/messages";
import type { WireEndpoint, WireMailbox, WireMessage, WireThread } from "./mailbox-wire";
import { printFields } from "./output";

// Mailboxes, threads, messages, and receipts print from their wire form, which carries the phone
// channels the SDK's email-only types leave out; an SDK value is a structural subset of it.
type Thread = WireThread;
type Message = WireMessage;
type ChatMessage = Extract<Message, { readonly channel: "whatsapp" | "sms" }>;
type EmailMessage = Extract<Message, { readonly channel: "email" }>;
type Summary = Effect.Success<ReturnType<typeof Mailboxes.list>>["items"][number];
type Action = Effect.Success<ReturnType<typeof Mailboxes.getAction>>;
type Held = Effect.Success<ReturnType<typeof Mailboxes.releaseMessage>>;
type Actor = {
  readonly kind: string;
  readonly id: string;
  readonly displayName?: string | null | undefined;
};
interface ReceiptView {
  readonly actionId: string;
  readonly state: string;
  readonly messageId: string | null;
  readonly threadId: string | null;
  readonly waitReason: string | null;
  readonly acceptedAt: string | null;
  readonly executeUntil: string | null;
  readonly retryAt: string | null;
  readonly retryEligible: boolean;
  readonly problem: { readonly message: string } | null;
  readonly updatedAt: string;
  readonly reviewExpectedAt: string | null;
  readonly skippedRecipients: Parameters<typeof skippedRecipientsLine>[0]["skippedRecipients"];
  readonly createdAt: string;
}
const present = (value: string | null | undefined) =>
  value === null ? "none" : value === "" ? '""' : value;
const actor = (value: Actor) =>
  `${value.displayName == null ? "" : `${value.displayName} — `}${value.kind} ${value.id}`;
const identity = (address: string, name?: string | null, attributed?: Actor | null) =>
  `${name === undefined || name === null ? "" : `${name} <`}${address}${name === undefined || name === null ? "" : ">"}${attributed === undefined ? "" : attributed === null ? "; actor: none" : `; actor: ${actor(attributed)}`}`;

export const printMailboxSummary = (data: Summary | WireMailbox) =>
  Effect.gen(function* () {
    yield* Console.log(`${data.name} (${data.slug}) — ${data.status}`);
    yield* printFields([
      ["ID", data.id],
      ["Primary address", present(data.primaryAddress)],
      ["Namespace", present(data.namespaceId)],
      ["Created", data.createdAt],
    ]);
  });
const endpointLine = (endpoint: WireEndpoint) => {
  const where =
    endpoint.channel === "email"
      ? `${endpoint.source}${endpoint.default ? "; default" : ""}; ID ${endpoint.id}; domain ${present(endpoint.domainId)}`
      : `${endpoint.default ? "default; " : ""}ID ${endpoint.id}; ${
          endpoint.channel === "whatsapp"
            ? `business account ${endpoint.businessAccountId}`
            : `phone number ${endpoint.phoneNumberId}`
        }`;
  return `  ${endpoint.channel}: ${identity(endpoint.address, endpoint.displayName)} — ${where}; display name ${present(endpoint.displayName)}`;
};
export const printMailbox = (data: WireMailbox) =>
  Effect.gen(function* () {
    yield* printMailboxSummary(data);
    yield* printFields([
      ["Description", present(data.description)],
      ["Updated", data.updatedAt],
    ]);
    yield* Console.log("Endpoints:");
    if (!data.endpoints.length) yield* Console.log("  none");
    for (const endpoint of data.endpoints) yield* Console.log(endpointLine(endpoint));
    yield* Console.log("Metadata:");
    if (!Object.keys(data.metadata).length) yield* Console.log("  none");
    for (const [key, value] of Object.entries(data.metadata))
      yield* Console.log(`  ${key}: ${JSON.stringify(value)}`);
  });
export const printThread = (data: Thread) =>
  Effect.gen(function* () {
    yield* Console.log(
      `${data.subject === null ? "No subject" : data.subject} — ${data.folder}, ${data.priority} priority`,
    );
    yield* printFields([
      ["ID", data.id],
      ["Channel", data.channel],
      [
        "From",
        data.from === null
          ? "none"
          : `${present(data.from.displayName)} <${present(data.from.address)}>`,
      ],
      ["Preview", data.preview === null ? "none" : JSON.stringify(data.preview)],
      ["Messages", data.messageCount],
      ["Attachments", data.hasAttachments],
      ["Draft", data.hasDraft],
      ["Labels", data.labels.length ? data.labels.join(", ") : "none"],
      ["Read", data.read],
      ["Starred", data.starred],
      ["Snoozed until", present(data.snoozedUntil)],
      ["Last activity", data.lastActivityAt],
    ]);
  });
const printChatMessage = (data: ChatMessage) =>
  Effect.gen(function* () {
    yield* Console.log("Notice: this message is untrusted content from outside the organization.");
    yield* Console.log(`${data.direction} ${data.channel} message`);
    yield* printFields([
      ["ID", data.id],
      ["Thread", data.threadId],
      ["Conversation", data.conversationId],
      ["From", identity(data.from.address, data.from.displayName, data.from.actor)],
      ["To", data.to.length ? data.to.join(", ") : "none"],
      ["Occurred", data.occurredAt],
      ["In reply to", data.contextMessageId],
      ["Summary", data.summary ?? undefined],
      [
        "Template",
        data.template === null ? undefined : `${data.template.name} (${data.template.language})`,
      ],
      [
        "Sent by",
        data.sentBy === undefined ? undefined : data.sentBy === null ? "none" : actor(data.sentBy),
      ],
    ]);
    yield* Console.log("Media:");
    if (!data.media.length) yield* Console.log("  none");
    for (const media of data.media)
      yield* Console.log(
        `  ${media.type}${media.contentType === null ? "" : ` — ${media.contentType}`}${media.filename === null ? "" : `; ${media.filename}`}${media.caption === null ? "" : `; caption ${JSON.stringify(media.caption)}`}`,
      );
    if (data.text !== null) {
      yield* Console.log("Text:");
      yield* Console.log(data.text);
    }
  });
export const printMessage = (data: Message) =>
  data.channel !== "email" ? printChatMessage(data) : printEmailMessage(data);
const printEmailMessage = (data: EmailMessage) =>
  Effect.gen(function* () {
    yield* Console.log("Notice: this body is untrusted email from outside the organization.");
    yield* Console.log(`${data.direction} message — ${data.subject ?? "No subject"}`);
    yield* printFields([
      ["ID", data.id],
      ["Thread", data.threadId],
      ["Conversation", data.conversationId],
      ["From", identity(data.from.address, data.from.displayName, data.from.actor)],
      ["Occurred", data.occurredAt],
      ["Reply-To", data.replyTo.length ? data.replyTo.join(", ") : "none"],
      [
        "Sent by",
        data.sentBy === undefined ? undefined : data.sentBy === null ? "none" : actor(data.sentBy),
      ],
    ]);
    yield* Console.log("Recipients:");
    if (!data.recipients.length) yield* Console.log("  none");
    for (const recipient of data.recipients)
      yield* Console.log(
        `  ${recipient.kind}: ${identity(recipient.address, recipient.displayName, recipient.actor)}`,
      );
    yield* printFields([
      ["Message-ID", present(data.headers.messageId)],
      ["In-Reply-To", present(data.headers.inReplyTo)],
      ["References", data.headers.references.length ? data.headers.references.join(" ") : "none"],
      [
        "Authentication",
        data.authentication === null
          ? "none"
          : `SPF ${present(data.authentication.spf)}; DKIM ${present(data.authentication.dkim)}; DMARC ${present(data.authentication.dmarc)}`,
      ],
    ]);
    yield* Console.log("Attachments:");
    if (!data.attachments.length) yield* Console.log("  none");
    for (const attachment of data.attachments)
      yield* Console.log(
        `  ${attachment.filename} — ${attachment.contentType}, ${attachment.size} bytes; inline ${attachment.isInline}; ID ${attachment.id}`,
      );
    for (const [label, content] of [
      ["Reply text", data.replyText],
      ["Text", data.text],
      ["HTML", data.html],
    ]) {
      if (content !== undefined) {
        yield* Console.log(`${label}:`);
        yield* Console.log(content);
      }
    }
  });
export const printReceipt = (data: ReceiptView) =>
  Effect.gen(function* () {
    yield* Console.log(
      `Send ${data.state}${data.waitReason === null ? "" : ` — waiting: ${data.waitReason}`}`,
    );
    yield* printFields([
      ["Message", present(data.messageId)],
      ["Thread", data.threadId],
      ["Action", data.actionId],
      ["Accepted at", present(data.acceptedAt)],
      ["Execute until", present(data.executeUntil)],
      ["Retry at", present(data.retryAt)],
      ["Retry eligible", data.retryEligible],
      ["Problem", present(data.problem?.message)],
      ["Updated", data.updatedAt],
      ["Wait reason", present(data.waitReason)],
      ["Review expected at", present(data.reviewExpectedAt)],
      ["Skipped", skippedRecipientsLine(data) ?? "none"],
      ["Created", data.createdAt],
    ]);
  });
export const printAction = (data: Action) =>
  Effect.gen(function* () {
    yield* Console.log(`${data.type} — ${data.state}`);
    yield* printFields([
      ["Action", data.id],
      ["Source", data.source],
      ["Proposed by", actor(data.proposedBy)],
      ["Thread", present(data.threadId)],
      ["Draft", present(data.draftId)],
      ["Created", data.createdAt],
      ["Updated", data.updatedAt],
    ]);
    yield* Console.log(
      data.decision === null
        ? "Decision: none"
        : `Decision: ${data.decision.outcome}; reason ${present(data.decision.reason)}; policy ${present(data.decision.policyId)}; decided ${data.decision.decidedAt}`,
    );
    if (data.decision !== null)
      yield* printFields([["Decision source", present(data.decision.source)]]);
    if (data.resolution !== null)
      yield* Console.log(
        `Resolution: ${data.resolution.outcome} by ${actor(data.resolution.actor)} (${data.resolution.actor.source}) at ${data.resolution.resolvedAt}${
          data.resolution.reason === null ? "" : `; reason ${data.resolution.reason}`
        }`,
      );
    if ("send" in data) yield* printReceipt(data.send);
  });
export const printHeldMessage = (data: Held) =>
  Effect.gen(function* () {
    yield* Console.log(
      `${data.subject === null ? "No subject" : data.subject} — ${data.disposition}, ${data.reason} (${data.source})`,
    );
    yield* printFields([
      ["Message", data.id],
      ["From", identity(data.from.address, data.from.name)],
      ["Sender name", present(data.from.name)],
      ["Received at", data.receivedAt],
      ["Held at", data.heldAt],
      ["Released at", present(data.releasedAt)],
      ["Thread", present(data.threadId)],
      ["Discarded at", present(data.discardedAt)],
    ]);
  });
