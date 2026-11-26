import { SamvaCliError, toCliApiError } from "../errors";

/** What an API key cannot do, as the verb the next step names. */
export type PersonOnlyAction = "approve" | "deny" | "release" | "discard" | "cancel" | "retry";

const personOnlyNext = (action: PersonOnlyAction) => {
  switch (action) {
    case "approve":
      return "Approving an action needs a person signed in with `samva login`, different from its proposer; an API key cannot approve.";
    case "deny":
      return "Denying an action needs a person signed in with `samva login`, different from its proposer; an API key cannot deny.";
    case "cancel":
      return "Cancelling a send needs a permitted person signed in with `samva login`; an API key cannot cancel.";
    case "retry":
      return "Resuming an action needs a permitted person signed in with `samva login`; an API key cannot resume it. Keep the original action and key.";
    case "release":
      return "Releasing a held message needs a person signed in with `samva login`; an API key cannot release.";
    case "discard":
      return "Discarding a held message needs a person signed in with `samva login`; an API key cannot discard.";
  }
};

/**
 * Mailbox commands report API failures through `toCliApiError`. Phone-channel
 * gates name the unavailable channel; person-only operations direct API-key callers to sign in.
 */
export const mailboxApiError = (
  prefix: string,
  error: unknown,
  options: { readonly personOnly?: PersonOnlyAction } = {},
): SamvaCliError => {
  const failure = toCliApiError(prefix, error);
  const flag = failure.api?.details.flag;
  if (failure.api?.reason === "FlagDisabledError" && flag === "sms")
    return new SamvaCliError({
      message: failure.message,
      api: {
        ...failure.api,
        next: "SMS is not enabled for this organization. Mailboxes can still use email and WhatsApp.",
      },
    });
  if (options.personOnly !== undefined && failure.api?.reason === "ForbiddenError")
    return new SamvaCliError({
      message: failure.message,
      api: { ...failure.api, next: personOnlyNext(options.personOnly) },
    });
  return failure;
};
