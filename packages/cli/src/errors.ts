import { MailboxSendReceipt } from "@samva/core/mailboxes/send";
import { formatReportedDiagnostic } from "@samva/core/shared/template-diagnostics";
import { TemplateSourceError } from "@samva/core/templates/source-error";
import * as CliError from "effect/cli/CliError";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import { ConflictError } from "samva/effect";

const ApiErrorGuidanceSchema = Schema.Struct({
  reason: Schema.String,
  status: Schema.Finite,
  details: Schema.Record(Schema.String, Schema.Unknown),
  next: Schema.optional(Schema.String),
});

/**
 * A user-facing CLI error. Its `message` is printed to stderr and the process
 * exits non-zero. Use this for expected failures (missing key, API errors,
 * bad input) — not for programmer bugs, which should surface as defects.
 */
export class SamvaCliError extends Schema.TaggedError<SamvaCliError>()("SamvaCliError", {
  message: Schema.String,
  api: Schema.optional(ApiErrorGuidanceSchema),
  details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

/** Expected process failures remain typed through the CLI boundary. */
export class CliUsageError extends Schema.TaggedError<CliUsageError>()("CliUsageError", {
  message: Schema.String,
  code: Schema.String,
}) {}

export class CliConfigError extends Schema.TaggedError<CliConfigError>()("CliConfigError", {
  message: Schema.String,
  code: Schema.String,
}) {}

export class CliAuthError extends Schema.TaggedError<CliAuthError>()("CliAuthError", {
  message: Schema.String,
  code: Schema.String,
}) {}

export class CliTimeoutError extends Schema.TaggedError<CliTimeoutError>()("CliTimeoutError", {
  message: Schema.String,
  code: Schema.String,
}) {}

/** A completed operation failed, but its structured result remains authoritative. */
export class CliResultError extends Schema.TaggedError<CliResultError>()("CliResultError", {
  message: Schema.String,
  code: Schema.String,
  result: Schema.Unknown,
  human: Schema.String,
}) {}

/**
 * A lifecycle command rendered its last authoritative Message before failing.
 * The process boundary preserves that output by branching on this class
 * (`instanceof`), so no marker field is needed on the error itself.
 */
export class CliMessageLifecycleError extends Schema.TaggedError<CliMessageLifecycleError>()(
  "CliMessageLifecycleError",
  {
    message: Schema.String,
    code: Schema.String,
    partialMessage: Schema.Unknown,
    api: Schema.optional(ApiErrorGuidanceSchema),
    next: Schema.String,
    human: Schema.String,
  },
) {}

export const processErrorCode = (error: unknown): number => {
  if ([401, 403].includes(apiErrorGuidance(error)?.status ?? 0)) return 4;
  if (CliError.isCliError(error)) return 2;
  if (error instanceof CliUsageError || error instanceof CliConfigError) return 2;
  if (error instanceof CliAuthError) return 4;
  if (error instanceof CliTimeoutError) return 124;
  if (error instanceof CliResultError) return 1;
  if (error instanceof CliMessageLifecycleError)
    return error.code === "message_wait_timeout" ? 124 : 1;
  return 1;
};

export const processErrorReason = (error: unknown): string => {
  if (CliError.isCliError(error)) return "usage_error";
  if (error instanceof CliUsageError) return error.code;
  if (error instanceof CliConfigError) return error.code;
  if (error instanceof CliAuthError) return error.code;
  if (error instanceof CliTimeoutError) return error.code;
  if (error instanceof CliResultError) return error.code;
  if (error instanceof CliMessageLifecycleError)
    return apiErrorGuidance(error)?.reason ?? error.code;
  return apiErrorGuidance(error)?.reason ?? "operational_failure";
};

export const processErrorNext = (error: unknown): string | undefined =>
  apiErrorGuidance(error)?.next ??
  (error instanceof CliMessageLifecycleError ? error.next : undefined);

const apiStatuses: Readonly<Record<string, number>> = {
  ValidationError: 422,
  TemplateSourceError: 422,
  AnalyticsQueryError: 400,
  BrandAddressRequiredError: 422,
  FromAddressRequiredError: 422,
  CampaignFooterRequiredError: 422,
  UnauthorizedError: 401,
  ForbiddenError: 403,
  ResourceNotFoundError: 404,
  ConflictError: 409,
  MailboxSendConflictError: 409,
  MailboxSendRefusedError: 403,
  CursorExpiredError: 410,
  WhatsAppSetupLinkUnavailableError: 410,
  MethodNotAllowedError: 405,
  UpgradeRequiredError: 426,
  RateLimitedError: 429,
  PaymentRequiredError: 402,
  FlagDisabledError: 403,
  OnboardingReviewRequiredError: 403,
  BillingProviderError: 502,
  DeliveryUnavailableError: 503,
  ServiceUnavailableError: 503,
  SenderNotReadyError: 503,
  EmailChannelError: 502,
  SmsChannelError: 502,
  WhatsAppChannelError: 502,
  CredentialsError: 500,
  NotImplementedError: 501,
  UnknownStatusError: 400,
  WhatsAppTemplateIneligibleError: 422,
  WhatsAppServiceWindowClosedError: 422,
  InternalError: 500,
  ExternalServiceError: 502,
  GatewayTimeoutError: 504,
};

export type ApiErrorGuidance = typeof ApiErrorGuidanceSchema.Type;

export const apiErrorGuidance = (error: unknown): ApiErrorGuidance | undefined => {
  if (
    (error instanceof SamvaCliError || error instanceof CliMessageLifecycleError) &&
    error.api !== undefined
  ) {
    return error.api;
  }
  if (!Predicate.isObject(error) || !("_tag" in error) || typeof error._tag !== "string") return;
  const status =
    (Schema.isSchema(error.constructor)
      ? SchemaAST.resolveAt<number>("httpApiStatus")(error.constructor.ast)
      : undefined) ?? apiStatuses[error._tag];
  if (status === undefined) return;
  const details = Object.fromEntries(
    Object.entries(error).filter(
      ([key]) =>
        !["_tag", "message", "name", "stack", "cause"].includes(key) &&
        !key.startsWith("_") &&
        // Compiler findings are public recovery data; runtime diagnostics can contain secrets.
        (!key.startsWith("diagnostic") ||
          (error._tag === "TemplateSourceError" && key === "diagnostics")),
    ),
  );
  if (error._tag === "MailboxSendConflictError" || error._tag === "MailboxSendRefusedError") {
    const receipt = Schema.encodeUnknownOption(MailboxSendReceipt)(details.receipt).pipe(
      Option.orElse(() =>
        Schema.decodeUnknownOption(Schema.toEncoded(MailboxSendReceipt))(details.receipt),
      ),
    );
    delete details.receipt;
    if (Option.isSome(receipt)) details.receipt = receipt.value;
  }
  let next: string | undefined;
  switch (error._tag) {
    case "ValidationError":
    case "AnalyticsQueryError":
      next = "Fix the listed fields before retrying.";
      break;
    case "TemplateSourceError":
      next =
        typeof details.revision === "string"
          ? "Reload the template workspace at the returned revision, fix the source at the listed diagnostics, then save again."
          : "Fix the template source at the listed diagnostics, then save again.";
      break;
    case "UnauthorizedError":
      next = "Run samva login, or set SAMVA_API_KEY to an active key.";
      break;
    case "ForbiddenError":
      next = "Use a key with the required scope and follow the API message.";
      break;
    case "RateLimitedError":
    case "ServiceUnavailableError":
      next =
        typeof details.retryAfterSeconds === "number"
          ? `Wait ${details.retryAfterSeconds} seconds before retrying.`
          : "Wait a moment before retrying.";
      break;
    case "SenderNotReadyError":
      next =
        typeof details.retryAfterSeconds === "number"
          ? `Wait ${details.retryAfterSeconds} seconds before retrying.`
          : "Wait for the sending identity to be ready before retrying.";
      break;
    case "FromAddressRequiredError":
      next =
        Array.isArray(details.verifiedDomains) && details.verifiedDomains.length > 0
          ? `Pass --from with an address on ${details.verifiedDomains.join(", ")}, or add a sender there and run samva email senders set-default.`
          : "Verify a domain or a sender (samva email domains add, samva email senders add), then set a default sender.";
      break;
    case "CursorExpiredError":
      next = "Read current state from the API, then retry without the cursor.";
      break;
    case "ResourceNotFoundError":
      next = "List the resource to find a valid id before retrying.";
      break;
    case "OnboardingReviewRequiredError":
      next = String(details.nextAction);
      break;
    case "PaymentRequiredError":
      next = "Review your plan and limits in the dashboard billing page.";
      break;
    case "FlagDisabledError":
      next = "Use an enabled feature for this organization.";
      break;
    case "BrandAddressRequiredError":
    case "CampaignFooterRequiredError":
      next = "Fix the brand footer as the API message describes before retrying.";
      break;
    case "MailboxSendConflictError":
    case "MailboxSendRefusedError":
      next =
        "Read the original action with samva mailboxes actions get; preserve its action ID and send key. Accepted email cannot be withdrawn; uncertain work requires reconciliation. Never create a replacement key as recovery.";
      break;
    case "WhatsAppServiceWindowClosedError":
      next =
        "Free-form WhatsApp text needs the customer's open 24-hour service window. Send an approved template instead: --template <templateId> with --data.";
      break;
    case "ConflictError":
      next = "Read the resource and resolve the conflict before retrying.";
      break;
    default:
      next = "Retry once; if it still fails, run samva feedback send and name the command.";
  }
  return { reason: error._tag, status, details, next };
};

/** Preserve the API's recovery fields across command-specific failure handling. */
export const toCliApiError = (
  prefix: string,
  error: unknown,
  details?: Readonly<Record<string, unknown>>,
): SamvaCliError =>
  new SamvaCliError({
    message: formatApiError(prefix, error),
    api: apiErrorGuidance(error),
    details,
  });

export const formatApiError = (prefix: string, error: unknown): string => {
  if (
    Predicate.isObject(error) &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.length > 0
  ) {
    return apiErrorGuidance(error) === undefined ? `${prefix}: ${error.message}` : error.message;
  }
  return prefix;
};

export const formatErrorDetails = (error: unknown): string => {
  const api = apiErrorGuidance(error);
  const fields = api?.details.fields;
  const fieldDetails = Predicate.isObject(fields)
    ? Object.entries(fields)
        .map(
          ([path, issue]) =>
            `\n  ${path}: ${Array.isArray(issue) ? issue.join("; ") : String(issue)}`,
        )
        .join("")
    : "";
  if (api?.reason !== "TemplateSourceError") return fieldDetails;
  const diagnostics = Schema.decodeUnknownSync(TemplateSourceError.fields.diagnostics)(
    api.details.diagnostics,
  );
  return (
    fieldDetails +
    diagnostics
      .map(({ origins, ...diagnostic }) => {
        const origin = origins[0];
        const finding = formatReportedDiagnostic({
          ...diagnostic,
          file: origin?.fileName ?? "Template source",
          line: origin?.lineNumber,
          column: origin?.columnNumber,
        });
        return `\n  ${finding}${origins
          .slice(1)
          .map((at) => `\n    via ${at.fileName}:${at.lineNumber}:${at.columnNumber}`)
          .join("")}`;
      })
      .join("")
  );
};

export const getConflictError = (error: unknown): ConflictError | undefined =>
  error instanceof ConflictError ? error : undefined;
