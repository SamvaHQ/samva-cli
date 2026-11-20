import { TemplateId } from "@samva/core/shared/base";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Templates from "samva/effect/templates";
import * as Whoami from "samva/effect/whoami";

import { resolveExecutionContext } from "../../config/store";
import { SamvaCliError, toCliApiError } from "../../errors";
import { getClientProvider } from "../../lib/client";
import { namespaceField, namespaceFlag } from "../../lib/namespace";
import { jsonFlag, printFields, printJson } from "../../lib/output";
import { editorPath, webOriginForApi } from "./from-website-command";
import { briefArgument, channelFlag, recreationNote } from "./suggest-command";

export const fromBriefCommand = Command.make("from-brief", {
  brief: briefArgument,
  channel: channelFlag,
  name: Flag.String("name").pipe(
    Flag.withDescription(
      "Name for the new template; defaults to the name of the design it starts from",
    ),
    Flag.optional,
  ),
  galleryTemplate: Flag.String("gallery-template").pipe(
    Flag.withDescription(
      "Start from this gallery template id instead of the best match (see `samva templates suggest`)",
    ),
    Flag.optional,
  ),
  variantOf: Flag.String("variant-of").pipe(
    Flag.withSchema(TemplateId),
    Flag.withDescription(
      "Make this template another channel's version of this template (tmpl_...): its files are mounted read-only for the assistant and the two join one family in its namespace",
    ),
    Flag.optional,
  ),
  namespace: namespaceFlag("create"),
  idempotencyKey: Flag.String("idempotency-key").pipe(
    Flag.withDescription(
      "Key (1-255 characters) so a retry returns the original template; generated per run when omitted",
    ),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Create a template project from a brief, starting from the gallery design that fits it",
  ),
  Command.withExamples([
    {
      command: 'samva templates from-brief "Welcome email for a coffee subscription"',
      description: "Create the project from the best match and print the editor link",
    },
    {
      command:
        'samva templates from-brief "Order shipped update" --gallery-template <id> --name "Shipped" --json',
      description: "Start from a chosen gallery template; machine-readable result",
    },
    {
      command:
        'samva templates from-brief "Order shipped, on WhatsApp" --channel whatsapp --variant-of <id>',
      description: "Make the WhatsApp version of an email template, carrying its content over",
    },
  ]),
  Command.withHandler(
    ({ brief, channel, name, galleryTemplate, variantOf, namespace, idempotencyKey, json }) =>
      Effect.gen(function* () {
        const key = Option.getOrUndefined(idempotencyKey);
        if (key !== undefined && (key.length < 1 || key.length > 255))
          return yield* new SamvaCliError({
            message: "--idempotency-key must contain between 1 and 255 characters.",
          });
        const client = yield* getClientProvider;
        const secureRandom = yield* SecureRandom.SecureRandom;
        const context = yield* resolveExecutionContext;
        // Resolve the organization slug before the write so a failure leaves nothing created.
        const orgSlug = context.apiKey
          ? (yield* Whoami.get().pipe(
              client.provide,
              Effect.mapError((error) =>
                toCliApiError("Could not look up the organization", error),
              ),
            )).organization.slug
          : context.orgSlug;
        const result = yield* Templates.createFromBrief(
          {
            brief,
            channel,
            ...(Option.isSome(name) ? { name: name.value } : {}),
            ...(Option.isSome(galleryTemplate) ? { galleryTemplateId: galleryTemplate.value } : {}),
            ...(Option.isSome(variantOf) ? { variantOf: variantOf.value } : {}),
            ...namespaceField(namespace),
          },
          { idempotencyKey: key ?? (yield* secureRandom.uuidV4()) },
        ).pipe(
          client.provide,
          Effect.mapError((error) =>
            toCliApiError("Could not create a template from the brief", error),
          ),
        );
        const path =
          orgSlug === undefined ? null : editorPath(orgSlug, result.template.id, result.ask);
        const origin = webOriginForApi(context.apiUrl);
        const editorUrl = path !== null && origin !== null ? `${origin}${path}` : null;
        if (json)
          return yield* printJson({
            template: { id: result.template.id, name: result.template.name },
            startedFrom: result.startedFrom,
            alternatives: result.alternatives,
            recreation: result.recreation,
            ask: result.ask,
            editorUrl,
          });
        yield* printFields([
          ["Template", result.template.id],
          ["Started from", `${result.startedFrom.name} (${result.startedFrom.galleryTemplateId})`],
          ...(editorUrl !== null
            ? ([["Editor", editorUrl]] as const)
            : ([["Ask", result.ask]] as const)),
        ]);
        const note = recreationNote(result.recreation, result.startedFrom);
        if (note !== null) yield* Console.log(note);
      }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
