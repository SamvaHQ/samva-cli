import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";

import { CliUsageError, SamvaCliError, toCliApiError } from "../errors";
import { getAuthenticatedJson, postAuthenticatedJson } from "../lib/client";
import { jsonFlag, printFields, printJson } from "../lib/output";
import { waitingLine } from "./messages";
import { broadcasts, templatesStats } from "./whatsapp-broadcasts";
import {
  resolveWhatsappContent,
  WHATSAPP_FLOW_ACTIONS,
  WHATSAPP_MEDIA_TYPES,
} from "./whatsapp-content";
import { flows } from "./whatsapp-flows";
import {
  readRegistrations,
  registrationGet,
  registrationsList,
  registrationSubmit,
  registrationSummary,
  type WireRegistration,
} from "./whatsapp-registrations";
import { setupLinks } from "./whatsapp-setup-links";

// WhatsApp commands use authenticated JSON for resources omitted from the public SDK.
// Connection is completed in the dashboard or through a setup link; proof runners remain scaffolds.

const E164 = /^\+[1-9]\d{6,14}$/;

const WhatsAppAccountPage = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      phoneNumber: Schema.String,
      displayName: Schema.String,
      verificationStatus: Schema.String,
      credentialStatus: Schema.String,
      isDefault: Schema.Boolean,
      isActive: Schema.Boolean,
      qualityRating: Schema.String,
      messagingLimit: Schema.NullOr(Schema.String),
      currentLimit: Schema.Finite,
    }),
  ),
  pagination: Schema.Struct({
    page: Schema.Finite,
    limit: Schema.Finite,
    total: Schema.Finite,
    totalPages: Schema.Finite,
  }),
});

const status = Command.make("status", {
  page: Flag.Int("page").pipe(Flag.withDefault(1)),
  limit: Flag.Int("limit").pipe(Flag.withDefault(20)),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Show connected WhatsApp numbers, verification, quality, and messaging limits",
  ),
  Command.withHandler(({ page, limit, json }) =>
    Effect.gen(function* () {
      if (page < 1 || page > 10_000 || limit < 1 || limit > 100)
        return yield* new CliUsageError({
          code: "invalid_pagination",
          message: "--page must be between 1 and 10000; --limit must be between 1 and 100.",
        });
      const body = yield* getAuthenticatedJson(
        `/v1/whatsapp/business-accounts?page=${page}&limit=${limit}`,
      ).pipe(Effect.mapError((error) => toCliApiError("Could not read WhatsApp status", error)));
      const result = yield* Schema.decodeUnknownEffect(WhatsAppAccountPage)(body).pipe(
        Effect.mapError(
          () =>
            new SamvaCliError({
              message: "The API answered with an unreadable WhatsApp account list.",
            }),
        ),
      );
      if (json) return yield* printJson(result);
      if (result.pagination.total === 0) {
        yield* Console.log(
          "No WhatsApp numbers connected. Connect a number in the dashboard or create a connection link with `samva whatsapp setup-links create`.",
        );
        return;
      }
      for (const account of result.items) {
        yield* printFields([
          ["Account ID", account.id],
          ["Phone number", account.phoneNumber],
          ["Display name", account.displayName],
          ["Verification", account.verificationStatus],
          ["Credentials", account.credentialStatus],
          ["Default", account.isDefault ? "yes" : "no"],
          ["Active", account.isActive ? "yes" : "no"],
          ["Messaging tier", account.messagingLimit],
          ["Messaging limit", account.currentLimit],
          ["Quality", account.qualityRating],
        ]);
        yield* Console.log("");
      }
      yield* printFields([
        ["Page", `${result.pagination.page} of ${result.pagination.totalPages}`],
        ["Total", result.pagination.total],
      ]);
      if (result.pagination.page < result.pagination.totalPages)
        yield* Console.log(
          `More numbers: samva whatsapp status --page ${result.pagination.page + 1} --limit ${result.pagination.limit}`,
        );
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const toFlag = Flag.String("to").pipe(
  Flag.withDescription("Recipient phone number in E.164 format, such as +14155550123"),
);
const textFlag = Flag.String("text").pipe(
  Flag.withDescription(
    "Message body; free-form text needs an open 24-hour customer service window",
  ),
  Flag.optional,
);
const templateFlag = Flag.String("template").pipe(
  Flag.withDescription(
    "Approved template to send, by id (tmpl_…) or slug; the only way to open a conversation",
  ),
  Flag.optional,
);
const dataFlag = Flag.String("data").pipe(
  Flag.withDescription("Template variables as a JSON object; requires --template"),
  Flag.optional,
);
const contentFlag = Flag.String("content").pipe(
  Flag.withDescription(
    "The whatsapp object as JSON (interactive lists, media by upload, location, contacts); `@file.json` reads a file, `-` reads stdin",
  ),
  Flag.optional,
);
const mediaUrlFlag = Flag.String("media-url").pipe(
  Flag.withDescription("Public http(s) link to the media Meta fetches; requires --media-type"),
  Flag.optional,
);
const mediaTypeFlag = Flag.Literals("media-type", WHATSAPP_MEDIA_TYPES).pipe(
  Flag.withDescription("What --media-url is: image, video, audio, document, or sticker"),
  Flag.optional,
);
const captionFlag = Flag.String("caption").pipe(
  Flag.withDescription("Caption for image, video, or document media"),
  Flag.optional,
);
const filenameFlag = Flag.String("filename").pipe(
  Flag.withDescription("File name shown for document media"),
  Flag.optional,
);
const bodyFlag = Flag.String("body").pipe(
  Flag.withDescription("Message text of a reply-button message; requires --button"),
  Flag.optional,
);
const buttonFlag = Flag.String("button").pipe(
  Flag.withDescription(
    "Reply button as id:Title (repeatable, 1 to 3); the customer's tap comes back with the id",
  ),
  Flag.atLeast(0),
);
const footerFlag = Flag.String("footer").pipe(
  Flag.withDescription("Footer line of a reply-button message"),
  Flag.optional,
);
const reactFlag = Flag.String("react").pipe(
  Flag.withDescription("Message id (msg_…) in the same chat to react to; requires --emoji"),
  Flag.optional,
);
const emojiFlag = Flag.String("emoji").pipe(
  Flag.withDescription("The one emoji of the reaction; requires --react"),
  Flag.optional,
);
const flowFlag = Flag.String("flow").pipe(
  Flag.withDescription(
    "Flow to send, by id (waflow_…), registered on the sending number's business account; requires --cta and --body",
  ),
  Flag.optional,
);
const ctaFlag = Flag.String("cta").pipe(
  Flag.withDescription("Label of the button that opens the flow (30 characters); requires --flow"),
  Flag.optional,
);
const flowScreenFlag = Flag.String("flow-screen").pipe(
  Flag.withDescription(
    "Screen the flow opens on; its first screen when omitted; not with --flow-action data_exchange",
  ),
  Flag.optional,
);
const flowDataFlag = Flag.String("flow-data").pipe(
  Flag.withDescription("JSON object the opening screen reads; requires --flow-screen"),
  Flag.optional,
);
const flowTokenFlag = Flag.String("flow-token").pipe(
  Flag.withDescription(
    "Token returned unchanged on the customer's flow response and endpoint requests (the message id when omitted); with --flow, or with --template when the template has a flow button",
  ),
  Flag.optional,
);
const flowActionFlag = Flag.Literals("flow-action", WHATSAPP_FLOW_ACTIONS).pipe(
  Flag.withDescription(
    "How the flow opens: navigate (its own screens; takes --flow-screen and --flow-data) or data_exchange (the flow's endpoint answers the first screen; takes neither). Omitted, a data-exchange version opens with data_exchange and any other with navigate",
  ),
  Flag.optional,
);
const idempotencyKeyFlag = Flag.String("idempotency-key").pipe(
  Flag.withDescription("Key (1-255 characters) so identical retries return the original message"),
  Flag.optional,
);

/** The `POST /v1/messages` payload for one WhatsApp send of any content source. */
export const whatsappContentPayload = (to: string, content: Readonly<Record<string, unknown>>) => ({
  channel: "whatsapp" as const,
  to: [{ phone: to }],
  whatsapp: content,
});

/** The receipt fields the command reports; the endpoint answers with the full message receipt. */
const WhatsAppReceipt = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  waitReason: Schema.NullOr(Schema.String),
  reviewExpectedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});

const WHATSAPP_NEXT: Readonly<Record<string, string>> = {
  ValidationError:
    "Fix the listed fields. If the 24-hour customer service window is closed, every non-template send (text, media, buttons, reactions) is refused; send an approved template instead (`samva whatsapp templates list` shows which are approved). A reaction needs a msg_… id from the same chat that reached WhatsApp, and --media-url must be a public http(s) link of an accepted type.",
  ConflictError:
    "The template is not approved on the business account. Check `samva whatsapp templates list`, and resubmit with `samva whatsapp templates submit`.",
  SenderNotReadyError:
    "The business number is not registered yet. Finish WhatsApp signup or sync the number in the dashboard, then retry.",
  FlagDisabledError: "WhatsApp is not enabled for this organization.",
};

/** A failed WhatsApp send with the recovery step that names the WhatsApp cause. */
export const whatsappSendError = (error: unknown): SamvaCliError => {
  const failure = toCliApiError("Failed to send WhatsApp message", error);
  const next = failure.api === undefined ? undefined : WHATSAPP_NEXT[failure.api.reason];
  return next === undefined || failure.api === undefined
    ? failure
    : new SamvaCliError({
        message: failure.message,
        api: { ...failure.api, next },
        details: failure.details,
      });
};

const send = Command.make("send", {
  to: toFlag,
  text: textFlag,
  template: templateFlag,
  data: dataFlag,
  content: contentFlag,
  mediaUrl: mediaUrlFlag,
  mediaType: mediaTypeFlag,
  caption: captionFlag,
  filename: filenameFlag,
  body: bodyFlag,
  button: buttonFlag,
  footer: footerFlag,
  react: reactFlag,
  emoji: emojiFlag,
  flow: flowFlag,
  cta: ctaFlag,
  flowScreen: flowScreenFlag,
  flowData: flowDataFlag,
  flowToken: flowTokenFlag,
  flowAction: flowActionFlag,
  idempotencyKey: idempotencyKeyFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Send a WhatsApp message with exactly one content source: --text, --media-url, reply buttons (--body with --button), a --flow (with --cta and --body), a --react reaction, or any whatsapp object through --content, all inside the 24-hour customer service window; or an approved --template (with --data variables, and --flow-token for a template with a flow button) at any time.",
  ),
  Command.withExamples([
    {
      command: 'samva whatsapp send --to +14155550123 --text "Your order shipped."',
      description: "Reply to a customer who messaged you in the last 24 hours",
    },
    {
      command:
        'samva whatsapp send --to +14155550123 --template order-shipped --data \'{"orderNumber":"A-1042"}\'',
      description: "Send an approved template, which can open a conversation",
    },
    {
      command:
        "samva whatsapp send --to +14155550123 --template booking-invite --flow-token booking-4821",
      description:
        "Send a template whose flow button opens a flow; the token comes back on the customer's flow response",
    },
    {
      command:
        'samva whatsapp send --to +14155550123 --media-url https://example.com/receipt.pdf --media-type document --filename receipt.pdf --caption "Your receipt"',
      description: "Send a document by link",
    },
    {
      command:
        'samva whatsapp send --to +14155550123 --body "Shall we ship it today?" --button yes:Yes --button "no:Not yet"',
      description:
        "Ask with reply buttons; the customer's tap arrives as a message.received webhook",
    },
    {
      command:
        'samva whatsapp send --to +14155550123 --flow waflow_abc123 --cta "Book now" --body "Pick a time for your visit."',
      description:
        "Open a registered flow; the customer's answers arrive as a message.received webhook",
    },
    {
      command:
        'samva whatsapp send --to +14155550123 --flow waflow_abc123 --flow-action data_exchange --cta "Check in" --body "Confirm your booking."',
      description: "Open a flow whose endpoint answers the first screen",
    },
    {
      command: "samva whatsapp send --to +14155550123 --react msg_01j8k3m5n7p9q2r4s6tv --emoji 👍",
      description: "React to a message in the same chat",
    },
    {
      command: "samva whatsapp send --to +14155550123 --content @list.json",
      description: "Send a list, location, contacts, or uploaded media from a JSON file",
    },
  ]),
  Command.withHandler(
    ({
      to,
      text,
      template,
      data,
      content,
      mediaUrl,
      mediaType,
      caption,
      filename,
      body: messageBody,
      button,
      footer,
      react,
      emoji,
      flow,
      cta,
      flowScreen,
      flowData,
      flowToken,
      flowAction,
      idempotencyKey,
      json,
    }) =>
      Effect.gen(function* () {
        if (!E164.test(to)) {
          return yield* new SamvaCliError({
            message: "--to must be a phone number in E.164 format, such as +14155550123.",
          });
        }
        const whatsapp = yield* resolveWhatsappContent({
          text: Option.getOrUndefined(text),
          template: Option.getOrUndefined(template),
          data: Option.getOrUndefined(data),
          content: Option.getOrUndefined(content),
          mediaUrl: Option.getOrUndefined(mediaUrl),
          mediaType: Option.getOrUndefined(mediaType),
          caption: Option.getOrUndefined(caption),
          filename: Option.getOrUndefined(filename),
          body: Option.getOrUndefined(messageBody),
          buttons: button,
          footer: Option.getOrUndefined(footer),
          react: Option.getOrUndefined(react),
          emoji: Option.getOrUndefined(emoji),
          flow: Option.getOrUndefined(flow),
          cta: Option.getOrUndefined(cta),
          flowScreen: Option.getOrUndefined(flowScreen),
          flowData: Option.getOrUndefined(flowData),
          flowToken: Option.getOrUndefined(flowToken),
          flowAction: Option.getOrUndefined(flowAction),
        });
        const key = idempotencyKey._tag === "Some" ? idempotencyKey.value : undefined;
        if (key !== undefined && (key.length < 1 || key.length > 255)) {
          return yield* new SamvaCliError({
            message: "--idempotency-key must contain between 1 and 255 characters.",
          });
        }
        // The public SDK describes the email channel only, so WhatsApp posts to the same endpoint
        // directly with the CLI's credentials.
        const receipt = yield* postAuthenticatedJson("/v1/messages", {
          body: whatsappContentPayload(to, whatsapp),
          headers: { "idempotency-key": key ?? crypto.randomUUID() },
        }).pipe(Effect.mapError(whatsappSendError));
        const projection = yield* Schema.decodeUnknownEffect(WhatsAppReceipt)(receipt).pipe(
          Effect.mapError(
            () =>
              new SamvaCliError({
                message: "The API answered with an unreadable message receipt.",
              }),
          ),
        );
        if (json) return yield* printJson(projection);
        yield* Effect.logInfo("WhatsApp message queued.\n");
        yield* printFields([
          ["Message ID", projection.id],
          ["Status", projection.status],
          ["Waiting", waitingLine(projection)],
        ]);
      }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

/** The template fields the listing reads from `GET /v1/templates`. */
const WhatsAppTemplateRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  status: Schema.String,
});
const WhatsAppTemplatePage = Schema.Struct({
  items: Schema.Array(WhatsAppTemplateRow),
  nextCursor: Schema.NullOr(Schema.String),
});

/** One WhatsApp-channel template with every registration Meta has seen of it. */
export interface WhatsAppTemplateStatus {
  readonly template: typeof WhatsAppTemplateRow.Type;
  readonly registrations: ReadonlyArray<WireRegistration>;
}

/** The `GET /v1/templates` path for one page of WhatsApp-channel templates. */
export const whatsappTemplatesPath = (limit: number | undefined, cursor: string | undefined) => {
  const query = new URLSearchParams({ channel: "whatsapp" });
  if (limit !== undefined) query.set("limit", String(limit));
  if (cursor !== undefined) query.set("cursor", cursor);
  return `/v1/templates?${query.toString()}`;
};

const REGISTRATION_READ_CONCURRENCY = 4;

const templatesList = Command.make("list", {
  limit: Flag.Int("limit").pipe(Flag.withDescription("Templates per page"), Flag.optional),
  cursor: Flag.String("cursor").pipe(
    Flag.withDescription("Resume after this nextCursor from a previous page"),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "List WhatsApp-channel templates with where each one's Meta review stands",
  ),
  Command.withExamples([
    {
      command: "samva whatsapp templates list",
      description: "See which templates are approved, in review, or rejected",
    },
  ]),
  Command.withHandler(({ limit, cursor, json }) =>
    Effect.gen(function* () {
      const body = yield* getAuthenticatedJson(
        whatsappTemplatesPath(Option.getOrUndefined(limit), Option.getOrUndefined(cursor)),
      ).pipe(Effect.mapError((error) => toCliApiError("Could not list WhatsApp templates", error)));
      const page = yield* Schema.decodeUnknownEffect(WhatsAppTemplatePage)(body).pipe(
        Effect.mapError(
          () =>
            new SamvaCliError({ message: "The API answered with an unreadable template list." }),
        ),
      );
      const items: ReadonlyArray<WhatsAppTemplateStatus> = yield* Effect.forEach(
        page.items,
        (template) =>
          readRegistrations(template.id).pipe(
            Effect.map((registrations) => ({ template, registrations })),
          ),
        { concurrency: REGISTRATION_READ_CONCURRENCY },
      );
      if (json) return yield* printJson({ items, nextCursor: page.nextCursor });
      if (items.length === 0) {
        yield* Effect.logInfo("No WhatsApp templates.");
        return;
      }
      for (const { template, registrations } of items) {
        yield* printFields([
          ["Template ID", template.id],
          ["Name", template.name],
          ["Slug", template.slug],
          ["Published", template.status],
          ["Registration", registrationSummary(registrations)],
        ]);
        yield* Console.log("");
      }
      if (page.nextCursor !== null) yield* printFields([["Next cursor", page.nextCursor]]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const templates = Command.make("templates").pipe(
  Command.withDescription("Manage WhatsApp message templates"),
  Command.withSubcommands([
    templatesList,
    templatesStats,
    registrationSubmit,
    registrationsList,
    registrationGet,
  ]),
);

const WhatsAppMessageStatus = Schema.Struct({
  id: Schema.String,
  channel: Schema.String,
  status: Schema.String,
  waitReason: Schema.NullOr(Schema.String),
  reviewExpectedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const messageStatus = Command.make("status", { id: Argument.String("id"), json: jsonFlag }).pipe(
  Command.withDescription("Check the lifecycle status of a WhatsApp message"),
  Command.withHandler(({ id, json }) =>
    Effect.gen(function* () {
      const body = yield* getAuthenticatedJson(`/v1/messages/${encodeURIComponent(id)}`).pipe(
        Effect.mapError((error) => toCliApiError("Could not read WhatsApp message status", error)),
      );
      const result = yield* Schema.decodeUnknownEffect(WhatsAppMessageStatus)(body).pipe(
        Effect.mapError(
          () => new SamvaCliError({ message: "The API answered with an unreadable message." }),
        ),
      );
      if (result.channel !== "whatsapp")
        return yield* new SamvaCliError({
          message: "This is not a WhatsApp message. Use `samva messages get` to inspect it.",
        });
      if (json) return yield* printJson(result);
      yield* printFields([
        ["Message ID", result.id],
        ["Channel", result.channel],
        ["Status", result.status],
        ["Waiting", waitingLine(result)],
        ["Created", result.createdAt],
        ["Updated", result.updatedAt],
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const message = Command.make("message").pipe(
  Command.withDescription("Inspect WhatsApp messages"),
  Command.withSubcommands([messageStatus]),
);

const proofLocal = Command.make("local").pipe(
  Command.withDescription("Run the local WhatsApp proof checklist"),
  Command.withHandler(
    Effect.fnUntraced(function* () {
      return yield* new SamvaCliError({
        message:
          "`samva whatsapp proof local` is not implemented yet; it lands with the guided proof runners.",
      });
    }),
  ),
);

const proofProduction = Command.make("production").pipe(
  Command.withDescription("Run the production WhatsApp proof checklist"),
  Command.withHandler(
    Effect.fnUntraced(function* () {
      return yield* new SamvaCliError({
        message:
          "`samva whatsapp proof production` is not implemented yet; it lands with the guided proof runners.",
      });
    }),
  ),
);

const proof = Command.make("proof").pipe(
  Command.withDescription("Guided WhatsApp proof runners"),
  Command.withSubcommands([proofLocal, proofProduction]),
);

export const whatsappCommand = Command.make("whatsapp").pipe(
  Command.withDescription(
    "WhatsApp — `send` delivers text, media, reply buttons, reactions, or any whatsapp object inside the 24-hour customer service window, or an approved template at any time; `templates list` shows each template's Meta review status and `templates stats` how each performed; `broadcasts` sends a template to an audience; `flows` creates, publishes, and registers flows; `setup-links` creates links that connect a customer's number into a namespace. `status` shows connected numbers and their verification, quality, and messaging limits; `message status <id>` reads a message's lifecycle status. Business account connection stays in the dashboard.",
  ),
  Command.withSubcommands([status, send, templates, broadcasts, flows, setupLinks, message, proof]),
);
