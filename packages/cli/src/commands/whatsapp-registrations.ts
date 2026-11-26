import {
  TemplateRegistration,
  TemplateRegistrationApproval,
} from "@samva/core/templates/registration";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TemplateRegistrations from "samva/effect/template-registrations";

import { CliUsageError, SamvaCliError, toCliApiError } from "../errors";
import { getAuthenticatedJson } from "../lib/client";
import { deriveOverride } from "../lib/derive/curated";
import { jsonFlag, printFields } from "../lib/output";

/**
 * `samva whatsapp templates submit | registrations | registration` — a template's content as
 * Meta has registered it.
 *
 * WhatsApp sends a business's first message only from a template Meta approved, so a published
 * template is submitted for review here and its status read back. The registrations API is
 * published in OpenAPI and the SDK.
 * These commands use authenticated JSON requests.
 */

/** A registration as the API wire carries it: dates stay ISO strings. */
const WireRegistration = Schema.toEncoded(TemplateRegistration);
export type WireRegistration = typeof WireRegistration.Type;
const WireRegistrationList = Schema.Struct({ data: Schema.Array(WireRegistration) });

const templateIdArgument = Argument.String("template-id").pipe(
  Argument.withDescription("Template whose registrations to act on"),
);
const registrationIdArgument = Argument.String("registration-id").pipe(
  Argument.withDescription("Registration to read, from `registrations`"),
);
const businessAccountFlag = Flag.String("business-account").pipe(
  Flag.withDescription(
    "WhatsApp business account to register on; the default number's account when omitted",
  ),
  Flag.optional,
);
const publicationFlag = Flag.String("publication").pipe(
  Flag.withDescription(
    "Reviewed publication ID. Requires --business-account, --waba-id and --workspace-revision",
  ),
  Flag.optional,
);
const wabaIdFlag = Flag.String("waba-id").pipe(
  Flag.withDescription("Meta business account ID shown on the reviewed connected number"),
  Flag.optional,
);
const workspaceRevisionFlag = Flag.String("workspace-revision").pipe(
  Flag.withDescription("The workspace revision reviewed for an exact submission"),
  Flag.optional,
);

/** The registrations collection of one template. */
export const registrationsPath = (templateId: string, registrationId?: string): string => {
  const base = `/v1/templates/${encodeURIComponent(templateId)}/registrations`;
  return registrationId === undefined ? base : `${base}/${encodeURIComponent(registrationId)}`;
};

/** The submit payload: WhatsApp is the one provider a registration targets. */
export const submitRegistrationPayload = (businessAccountId: string | undefined) => ({
  provider: "whatsapp" as const,
  ...(businessAccountId === undefined ? {} : { businessAccountId }),
});

const REGISTRATION_NEXT: Readonly<Record<string, string>> = {
  ConflictError:
    "Review the current publication and account again if they changed. Publish the template (`samva templates publish`) if needed, or wait for a review in progress to finish. A disabled template cannot be resubmitted.",
  ValidationError:
    "Read Meta's reason in the message, fix the template and publish it again, then resubmit. If no WhatsApp number is connected, connect one in the dashboard first.",
  WhatsAppChannelError: "Meta could not be reached or refused the request. Retry shortly.",
  CredentialsError:
    "The WhatsApp credentials need attention. Reconnect the business account in the dashboard, then retry.",
  ResourceNotFoundError:
    "Check the id: `samva templates list` shows templates, and `samva whatsapp templates registrations <template-id>` shows its registrations.",
};

/** A failed registrations call with the recovery step that names the registration cause. */
export const registrationError =
  (what: string) =>
  (error: unknown): SamvaCliError => {
    const failure = toCliApiError(`Could not ${what}`, error);
    const next = failure.api === undefined ? undefined : REGISTRATION_NEXT[failure.api.reason];
    return next === undefined || failure.api === undefined
      ? failure
      : new SamvaCliError({
          message: failure.message,
          api: { ...failure.api, next },
          details: failure.details,
        });
  };

/** The status a registration prints: an approved one a submission has not settled sends nothing. */
const statusLine = (registration: WireRegistration): string =>
  registration.status === "approved" && registration.pendingTemplateChannelVariantId !== null
    ? "approved, sending held until a submission settles (submit again)"
    : registration.status;

/** The labelled lines one registration prints in human mode. */
export const registrationFields = (
  registration: WireRegistration,
): ReadonlyArray<readonly [string, unknown]> => [
  ["Registration ID", registration.id],
  ["Template ID", registration.templateId],
  ["Publication ID", registration.publicationId],
  ["Status", statusLine(registration)],
  [
    "Business account",
    registration.target.provider === "whatsapp" ? registration.target.wabaId : undefined,
  ],
  ["Name", registration.name],
  ["Language", registration.language],
  ["Category", registration.category],
  ["Meta category", registration.providerCategory],
  ["Meta template ID", registration.providerTemplateId],
  ["Reason", registration.reason],
  ["Submitted", registration.submittedAt],
  ["Status changed", registration.statusChangedAt],
];

/** One line naming where each registration stands, or that none exists. */
export const registrationSummary = (registrations: ReadonlyArray<WireRegistration>): string =>
  registrations.length === 0
    ? "not submitted"
    : registrations
        .map(
          (registration) =>
            `${statusLine(registration)}${registration.reason === null ? "" : ` (${registration.reason})`}`,
        )
        .join("; ");

/** Read every registration of a template, newest first. */
export const readRegistrations = (templateId: string) =>
  getAuthenticatedJson(registrationsPath(templateId)).pipe(
    Effect.mapError(registrationError("list template registrations")),
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(WireRegistrationList)(body).pipe(
        Effect.mapError(
          () => new SamvaCliError({ message: "The API answered with an unreadable list." }),
        ),
      ),
    ),
    Effect.map((list) => list.data),
  );

const submit = deriveOverride(
  "submit",
  {
    id: templateIdArgument,
    businessAccount: businessAccountFlag,
    publication: publicationFlag,
    wabaId: wabaIdFlag,
    workspaceRevision: workspaceRevisionFlag,
    json: jsonFlag,
  },
  {
    prepare: ({ id, businessAccount, publication, wabaId, workspaceRevision }) =>
      Effect.gen(function* () {
        const approval =
          Option.isSome(publication) || Option.isSome(wabaId) || Option.isSome(workspaceRevision)
            ? yield* Schema.decodeUnknownEffect(Schema.toEncoded(TemplateRegistrationApproval))({
                publicationId: Option.getOrUndefined(publication),
                businessAccountId: Option.getOrUndefined(businessAccount),
                expectedWabaId: Option.getOrUndefined(wabaId),
                expectedWorkspaceRevision: Option.getOrUndefined(workspaceRevision),
              }).pipe(
                Effect.mapError(
                  () =>
                    new CliUsageError({
                      code: "invalid_registration_approval",
                      message:
                        "Use valid --publication, --business-account, --waba-id and --workspace-revision values together for a reviewed submission.",
                    }),
                ),
              )
            : undefined;
        return {
          id,
          provider: "whatsapp" as const,
          ...(approval === undefined
            ? { businessAccountId: Option.getOrUndefined(businessAccount) }
            : { approval }),
        };
      }),
    call: (request) => TemplateRegistrations.submit(request),
    failure: registrationError("submit the template registration"),
    render: (registration) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("Template submitted for review.\n");
        yield* printFields(registrationFields(registration));
      }),
  },
).pipe(
  Command.withDescription(
    "Submit the template's current publication to Meta for review. A newer publication resubmits through the same registration. Supply the reviewed publication, number, Meta business account and workspace revision to guard a previously approved submission.",
  ),
  Command.withExamples([
    {
      command: "samva whatsapp templates submit tmpl_abc123",
      description: "Register on the default number's business account",
    },
    {
      command: "samva whatsapp templates submit tmpl_abc123 --business-account waba_abc123",
      description: "Register on a specific business account",
    },
    {
      command:
        "samva whatsapp templates submit tmpl_abc123 --publication tpub_abc123 --business-account waba_abc123 --waba-id 1234567890 --workspace-revision 12 --json",
      description: "Submit the exact content and account reviewed earlier",
    },
  ]),
);

const list = deriveOverride(
  "registrations",
  { id: templateIdArgument, json: jsonFlag },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => TemplateRegistrations.list(request),
    failure: registrationError("list template registrations"),
    render: (page) =>
      Effect.gen(function* () {
        if (page.data.length === 0) {
          yield* Effect.logInfo(
            "No registrations. Submit one with `samva whatsapp templates submit <template-id>`.",
          );
          return;
        }
        for (const registration of page.data) {
          yield* printFields(registrationFields(registration));
          yield* Console.log("");
        }
      }),
  },
).pipe(
  Command.withDescription("List a template's Meta registrations, newest first"),
  Command.withExamples([
    {
      command: "samva whatsapp templates registrations tmpl_abc123 --json",
      description: "Read each registration's review status and Meta's reason",
    },
  ]),
);

const get = deriveOverride(
  "registration",
  {
    id: templateIdArgument,
    registrationId: registrationIdArgument,
    json: jsonFlag,
  },
  {
    mapInput: ({ id, registrationId }) => ({ id, registrationId }),
    call: (request) => TemplateRegistrations.get(request),
    failure: registrationError("get the template registration"),
    render: (registration) => printFields(registrationFields(registration)),
  },
).pipe(
  Command.withDescription("Get one registration: its status, Meta's category, and any reason"),
  Command.withExamples([
    {
      command: "samva whatsapp templates registration tmpl_abc123 treg_abc123",
      description: "Check whether Meta approved the template",
    },
  ]),
);

export { get as registrationGet, list as registrationsList, submit as registrationSubmit };
