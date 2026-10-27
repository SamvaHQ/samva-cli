import { TemplateRegistration } from "@samva/core/templates/registration";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";

import { SamvaCliError, toCliApiError } from "../errors";
import { getAuthenticatedJson, postAuthenticatedJson } from "../lib/client";
import { jsonFlag, printFields, printJson } from "../lib/output";

/**
 * `samva whatsapp templates submit | registrations | registration` — a template's content as
 * Meta has registered it.
 *
 * WhatsApp sends a business's first message only from a template Meta approved, so a published
 * template is submitted for review here and its status read back. The registrations API is hidden
 * (served while the `whatsapp` launch flag is on, absent from the public SDK), so the commands
 * call it directly with the CLI's credentials, as `samva whatsapp send` does. They live in the
 * unmounted `whatsapp` tree so the public binary advertises nothing flagged.
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
    "Publish the template (`samva templates publish`) if it has no publication, or wait for the review in progress to finish, then retry. A disabled template cannot be resubmitted.",
  ValidationError:
    "Read Meta's reason in the message, fix the template and publish it again, then resubmit. If no WhatsApp number is connected, connect one in the dashboard first.",
  WhatsAppChannelError: "Meta could not be reached or refused the request. Retry shortly.",
  CredentialsError:
    "The WhatsApp credentials need attention. Reconnect the business account in the dashboard, then retry.",
  ResourceNotFoundError:
    "Check the id: `samva templates list` shows templates, and `samva whatsapp templates registrations <template-id>` shows its registrations.",
  FlagDisabledError: "WhatsApp is not enabled for this organization.",
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

/** The labelled lines one registration prints in human mode. */
export const registrationFields = (
  registration: WireRegistration,
): ReadonlyArray<readonly [string, unknown]> => [
  ["Registration ID", registration.id],
  ["Template ID", registration.templateId],
  ["Publication ID", registration.publicationId],
  ["Status", registration.status],
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
            `${registration.status}${registration.reason === null ? "" : ` (${registration.reason})`}`,
        )
        .join("; ");

const decodeRegistration = (body: unknown) =>
  Schema.decodeUnknownEffect(WireRegistration)(body).pipe(
    Effect.mapError(
      () => new SamvaCliError({ message: "The API answered with an unreadable registration." }),
    ),
  );

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

const quiet = <A, E, R>(json: boolean, effect: Effect.Effect<A, E, R>) =>
  json ? Effect.provideService(effect, References.MinimumLogLevel, "None") : effect;

const submit = Command.make("submit", {
  id: templateIdArgument,
  businessAccount: businessAccountFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Submit the template's current publication to Meta for review. A newer publication resubmits through the same registration.",
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
  ]),
  Command.withHandler(({ id, businessAccount, json }) =>
    quiet(
      json,
      Effect.gen(function* () {
        const body = yield* postAuthenticatedJson(registrationsPath(id), {
          body: submitRegistrationPayload(Option.getOrUndefined(businessAccount)),
        }).pipe(Effect.mapError(registrationError("submit the template registration")));
        const registration = yield* decodeRegistration(body);
        if (json) return yield* printJson(registration);
        yield* Effect.logInfo("Template submitted for review.\n");
        yield* printFields(registrationFields(registration));
      }),
    ),
  ),
);

const list = Command.make("registrations", { id: templateIdArgument, json: jsonFlag }).pipe(
  Command.withDescription("List a template's Meta registrations, newest first"),
  Command.withExamples([
    {
      command: "samva whatsapp templates registrations tmpl_abc123 --json",
      description: "Read each registration's review status and Meta's reason",
    },
  ]),
  Command.withHandler(({ id, json }) =>
    quiet(
      json,
      Effect.gen(function* () {
        const registrations = yield* readRegistrations(id);
        if (json) return yield* printJson({ data: registrations });
        if (registrations.length === 0) {
          yield* Effect.logInfo(
            "No registrations. Submit one with `samva whatsapp templates submit <template-id>`.",
          );
          return;
        }
        for (const registration of registrations) {
          yield* printFields(registrationFields(registration));
          yield* Console.log("");
        }
      }),
    ),
  ),
);

const get = Command.make("registration", {
  id: templateIdArgument,
  registrationId: registrationIdArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Get one registration: its status, Meta's category, and any reason"),
  Command.withExamples([
    {
      command: "samva whatsapp templates registration tmpl_abc123 treg_abc123",
      description: "Check whether Meta approved the template",
    },
  ]),
  Command.withHandler(({ id, registrationId, json }) =>
    quiet(
      json,
      Effect.gen(function* () {
        const body = yield* getAuthenticatedJson(registrationsPath(id, registrationId)).pipe(
          Effect.mapError(registrationError("get the template registration")),
        );
        const registration = yield* decodeRegistration(body);
        if (json) return yield* printJson(registration);
        yield* printFields(registrationFields(registration));
      }),
    ),
  ),
);

export { get as registrationGet, list as registrationsList, submit as registrationSubmit };
