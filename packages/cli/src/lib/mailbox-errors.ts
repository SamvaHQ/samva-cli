import { HttpClientError } from "effect/http";

import { SamvaCliError, toCliApiError } from "../errors";

/**
 * The status of a response the SDK could not decode into a tagged error. The mailbox launch flag
 * answers a disabled route with an empty 404, which arrives this way.
 */
const undecodedStatus = (error: unknown) =>
  HttpClientError.isHttpClientError(error) ? error.response?.status : undefined;

/** A request made outside the SDK reports the gate's empty 404 as an unreadable body. */
const isUnreadable404 = (error: unknown) =>
  error instanceof SamvaCliError && error.message.includes("HTTP 404, unreadable body");

const GATED_NEXT =
  "Mailboxes are not enabled for this organization (the `mailbox` launch flag is off). Mailbox commands work once it is enabled.";

/** What an API key cannot do, as the verb the next step names. */
export type PersonOnlyAction =
  | "approve"
  | "deny"
  | "release"
  | "discard"
  | "publish"
  | "install"
  | "manage"
  | "cancel"
  | "retry";

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
    case "publish":
      return "Publishing an extension needs a person signed in with `samva login`; an API key cannot publish.";
    case "install":
      return "Installing an extension needs a person signed in with `samva login`; an API key cannot install.";
    case "manage":
      return "Managing an installation needs a person signed in with `samva login`; an API key cannot.";
  }
};

/**
 * Mailbox and extension commands report API failures through `toCliApiError`, with two
 * refinements. The `mailbox` launch flag gate answers an empty-body 404, which reaches the client
 * as a status failure rather than a typed `ResourceNotFoundError`. A `personOnly` operation
 * refuses API keys with 403, and its recovery is signing in as a person rather than changing key
 * scopes.
 */
export const mailboxApiError = (
  prefix: string,
  error: unknown,
  options: { readonly personOnly?: PersonOnlyAction } = {},
): SamvaCliError => {
  if (undecodedStatus(error) === 404 || isUnreadable404(error))
    return new SamvaCliError({
      message: `${prefix}: mailboxes are not enabled for this organization.`,
      api: { reason: "FlagDisabledError", status: 404, details: {}, next: GATED_NEXT },
    });
  const failure = toCliApiError(prefix, error);
  const flag = failure.api?.details.flag;
  if (failure.api?.reason === "FlagDisabledError" && (flag === "whatsapp" || flag === "sms"))
    return new SamvaCliError({
      message: failure.message,
      api: {
        ...failure.api,
        next: `${flag === "sms" ? "SMS" : "WhatsApp"} is not enabled for this organization. Mailboxes work on email until it is.`,
      },
    });
  if (options.personOnly !== undefined && failure.api?.reason === "ForbiddenError")
    return new SamvaCliError({
      message: failure.message,
      api: { ...failure.api, next: personOnlyNext(options.personOnly) },
    });
  return failure;
};
