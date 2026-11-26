import type { EmailSendWaitReason } from "@samva/core/email/scheduling";

/** What each wait reason means, for human output. Machine output keeps the API's value. */
const WAIT_REASON_PHRASES: Record<EmailSendWaitReason, string> = {
  rate: "sending capacity",
  "daily-quota": "daily sending capacity",
  "domain-health": "domain verification to recover",
  "sending-paused": "sending to resume",
  "upstream-unavailable": "the email provider",
  retry: "the next retry",
  "campaign-paused": "the campaign to resume",
  "domain-warming": "the domain warming plan",
  "onboarding-review": "Samva's review of the organization; it sends once the review approves it",
  "content-review": "Samva's review of this email's content",
  "screening-unavailable": "Samva's content check",
};

/** A wait reason in words, or the raw value when the API names one this CLI does not know. */
export const waitReasonPhrase = (waitReason: string): string =>
  Object.hasOwn(WAIT_REASON_PHRASES, waitReason)
    ? WAIT_REASON_PHRASES[waitReason as EmailSendWaitReason]
    : waitReason.replaceAll("-", " ");
