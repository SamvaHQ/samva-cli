import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Predicate from "effect/Predicate";

import { CliUsageError, type SamvaCliError } from "../errors";
import { readStdinUtf8 } from "../lib/stdin";

// A `samva whatsapp send` names exactly one content source. The flags below build the `whatsapp`
// object of `POST /v1/messages` for the common sources; `--content` carries any other source
// verbatim. The server (`WhatsAppSendContent`) owns every limit, so these builders check only what
// the flags themselves make ambiguous.

/** The media types a `whatsapp.media` object names (`WhatsAppOutboundMedia`). */
export const WHATSAPP_MEDIA_TYPES = ["image", "video", "audio", "document", "sticker"] as const;
export type WhatsAppMediaKind = (typeof WHATSAPP_MEDIA_TYPES)[number];

/** Media types that accept a caption; audio and stickers carry none. */
const CAPTIONED: ReadonlyArray<WhatsAppMediaKind> = ["image", "video", "document"];

/** Every content flag of `samva whatsapp send`, already unwrapped from `Option`. */
export interface WhatsAppContentFlags {
  readonly text: string | undefined;
  readonly template: string | undefined;
  readonly data: string | undefined;
  readonly content: string | undefined;
  readonly mediaUrl: string | undefined;
  readonly mediaType: WhatsAppMediaKind | undefined;
  readonly caption: string | undefined;
  readonly filename: string | undefined;
  readonly body: string | undefined;
  readonly buttons: ReadonlyArray<string>;
  readonly footer: string | undefined;
  readonly react: string | undefined;
  readonly emoji: string | undefined;
  readonly flow: string | undefined;
  readonly cta: string | undefined;
  readonly flowScreen: string | undefined;
  readonly flowData: string | undefined;
  readonly flowToken: string | undefined;
  readonly flowAction: WhatsAppFlowAction | undefined;
}

/** How a flow message opens its flow (`--flow-action`); mirrors `WhatsAppFlowAction`. */
export const WHATSAPP_FLOW_ACTIONS = ["navigate", "data_exchange"] as const;
export type WhatsAppFlowAction = (typeof WHATSAPP_FLOW_ACTIONS)[number];

const usage = (code: string, message: string) => new CliUsageError({ code, message });

/** A template id starts with `tmpl_`; a slug cannot contain an underscore. */
const isTemplateId = (reference: string): boolean => reference.startsWith("tmpl_");

/**
 * The `whatsapp` object of one approved-template send. `flowToken` fills the template's flow
 * button and comes back on the customer's flow response.
 */
export const whatsappTemplateContent = (
  template: string,
  data: Readonly<Record<string, unknown>> | undefined,
  flowToken?: string | undefined,
) => ({
  ...(isTemplateId(template) ? { templateId: template } : { templateSlug: template }),
  ...(data === undefined ? {} : { templateData: data }),
  ...(flowToken === undefined ? {} : { flowToken }),
});

/** The `whatsapp` object of one media message sent by link. */
export const whatsappMediaContent = (input: {
  readonly url: string;
  readonly type: WhatsAppMediaKind;
  readonly caption?: string | undefined;
  readonly filename?: string | undefined;
}) => ({
  media: {
    type: input.type,
    url: input.url,
    ...(input.caption === undefined ? {} : { caption: input.caption }),
    ...(input.filename === undefined ? {} : { filename: input.filename }),
  },
});

/** Split `id:Title` at the first colon, so a title may itself contain colons. */
export const parseWhatsappButton = (
  raw: string,
): Effect.Effect<{ readonly id: string; readonly title: string }, CliUsageError> => {
  const separator = raw.indexOf(":");
  const id = separator < 0 ? "" : raw.slice(0, separator).trim();
  const title = separator < 0 ? "" : raw.slice(separator + 1).trim();
  return id.length === 0 || title.length === 0
    ? Effect.fail(
        usage(
          "invalid_whatsapp_button",
          `--button must be id:Title with both parts present, such as confirm:Confirm; got "${raw}".`,
        ),
      )
    : Effect.succeed({ id, title });
};

/** The `whatsapp` object of one reply-button message; the customer's tap returns the button `id`. */
export const whatsappButtonsContent = (input: {
  readonly body: string;
  readonly footer?: string | undefined;
  readonly buttons: ReadonlyArray<{ readonly id: string; readonly title: string }>;
}) => ({
  interactive: {
    type: "buttons" as const,
    body: input.body,
    ...(input.footer === undefined ? {} : { footer: input.footer }),
    buttons: input.buttons,
  },
});

/** The `whatsapp` object of one flow message; the customer taps `cta` and fills the flow in WhatsApp. */
export const whatsappFlowContent = (input: {
  readonly flowId: string;
  readonly cta: string;
  readonly body: string;
  readonly footer?: string | undefined;
  readonly token?: string | undefined;
  readonly action?: WhatsAppFlowAction | undefined;
  readonly screen?: string | undefined;
  readonly data?: Readonly<Record<string, unknown>> | undefined;
}) => ({
  interactive: {
    type: "flow" as const,
    body: input.body,
    ...(input.footer === undefined ? {} : { footer: input.footer }),
    flowId: input.flowId,
    cta: input.cta,
    ...(input.token === undefined ? {} : { token: input.token }),
    ...(input.action === undefined ? {} : { action: input.action }),
    ...(input.screen === undefined ? {} : { screen: input.screen }),
    ...(input.data === undefined ? {} : { data: input.data }),
  },
});

/** The `whatsapp` object of one reaction to a message in the same chat. */
export const whatsappReactionContent = (messageId: string, emoji: string) => ({
  reaction: { messageId, emoji },
});

/** Parse `--data`: a JSON object of template variables. */
export const parseWhatsappTemplateData = (
  raw: string | undefined,
): Effect.Effect<Readonly<Record<string, unknown>> | undefined, CliUsageError> => {
  // @effect-diagnostics-next-line effectSucceedWithVoid:off -- undefined is a real success value (no template data), not a void outcome; Effect.void is not assignable to the `... | undefined` return.
  if (raw === undefined) return Effect.succeed(undefined);
  const invalid = usage("invalid_data", "--data must be a JSON object.");
  return Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: () => invalid,
  }).pipe(
    Effect.flatMap((parsed) =>
      Predicate.isObject(parsed) && !Array.isArray(parsed)
        ? Effect.succeed(parsed as Readonly<Record<string, unknown>>)
        : Effect.fail(invalid),
    ),
  );
};

/** Parse `--flow-data`: a JSON object the flow's opening screen reads. */
export const parseWhatsappFlowData = (
  raw: string | undefined,
): Effect.Effect<Readonly<Record<string, unknown>> | undefined, CliUsageError> => {
  // @effect-diagnostics-next-line effectSucceedWithVoid:off -- undefined is a real success value (no flow data), not a void outcome.
  if (raw === undefined) return Effect.succeed(undefined);
  const invalid = usage("invalid_flow_data", "--flow-data must be a JSON object.");
  return Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: () => invalid,
  }).pipe(
    Effect.flatMap((parsed) =>
      Predicate.isObject(parsed) && !Array.isArray(parsed)
        ? Effect.succeed(parsed as Readonly<Record<string, unknown>>)
        : Effect.fail(invalid),
    ),
  );
};

/** Parse `--content` text: the `whatsapp` object itself. */
export const parseWhatsappContent = (
  raw: string,
): Effect.Effect<Readonly<Record<string, unknown>>, CliUsageError> => {
  const invalid = usage(
    "invalid_content",
    '--content must be a JSON object holding one content source, such as {"text":"Hi"}.',
  );
  return Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: () => invalid,
  }).pipe(
    Effect.flatMap((parsed) =>
      Predicate.isObject(parsed) && !Array.isArray(parsed)
        ? Effect.succeed(parsed as Readonly<Record<string, unknown>>)
        : Effect.fail(invalid),
    ),
  );
};

/** Read `--content`: inline JSON, `@path` for a file, or `-` for piped stdin. */
export const readWhatsappContentSource = (
  raw: string,
): Effect.Effect<string, CliUsageError | SamvaCliError, FileSystem.FileSystem> => {
  if (raw === "-") return readStdinUtf8;
  if (!raw.startsWith("@")) return Effect.succeed(raw);
  const path = raw.slice(1);
  if (path.length === 0) {
    return Effect.fail(
      usage(
        "missing_content_file",
        "--content @ requires a file path, such as --content @msg.json.",
      ),
    );
  }
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(path);
  }).pipe(
    Effect.mapError(() =>
      usage("content_file_unreadable", `Could not read --content from ${path}.`),
    ),
  );
};

/** The flags that pick a content source, in the order the error message lists them. */
const chosenSources = (flags: WhatsAppContentFlags): ReadonlyArray<string> => [
  ...(flags.text === undefined ? [] : ["--text"]),
  ...(flags.template === undefined ? [] : ["--template"]),
  ...(flags.content === undefined ? [] : ["--content"]),
  ...(flags.mediaUrl === undefined ? [] : ["--media-url"]),
  ...(flags.flow === undefined ? [] : ["--flow"]),
  // With --flow, --body is the flow message's text; only --button still names a second source.
  ...(flags.flow === undefined
    ? flags.body === undefined && flags.buttons.length === 0
      ? []
      : ["--body/--button"]
    : flags.buttons.length === 0
      ? []
      : ["--button"]),
  ...(flags.react === undefined ? [] : ["--react"]),
];

const SOURCE_FLAGS =
  "--text, --template, --content, --media-url, --body with --button, --flow with --cta and --body, or --react";

/** A companion flag given without the source it modifies. */
const orphanedCompanion = (
  flags: WhatsAppContentFlags,
  sources: ReadonlyArray<string>,
): CliUsageError | undefined => {
  const needs = (companion: string, source: string) =>
    usage("flag_without_source", `${companion} applies only with ${source}.`);
  const only = (source: string) => sources.length === 1 && sources[0] === source;
  if (flags.data !== undefined && !only("--template")) return needs("--data", "--template");
  if (flags.mediaType !== undefined && !only("--media-url"))
    return needs("--media-type", "--media-url");
  if (flags.caption !== undefined && !only("--media-url")) return needs("--caption", "--media-url");
  if (flags.filename !== undefined && !only("--media-url"))
    return needs("--filename", "--media-url");
  if (flags.footer !== undefined && !only("--body/--button") && !only("--flow")) {
    return needs("--footer", "--body and --button, or --flow");
  }
  if (flags.cta !== undefined && !only("--flow")) return needs("--cta", "--flow");
  if (flags.flowScreen !== undefined && !only("--flow")) {
    return needs("--flow-screen", "--flow");
  }
  if (flags.flowData !== undefined && !only("--flow")) return needs("--flow-data", "--flow");
  if (flags.flowToken !== undefined && !only("--flow") && !only("--template")) {
    return needs("--flow-token", "--flow or --template");
  }
  if (flags.flowAction !== undefined && !only("--flow")) return needs("--flow-action", "--flow");
  if (flags.emoji !== undefined && !only("--react")) return needs("--emoji", "--react");
  return undefined;
};

/**
 * The `whatsapp` object a send carries, or a usage error naming the flag to fix. Exactly one
 * content source must be present; the server stays the authority for every length and count.
 */
export const resolveWhatsappContent = (
  flags: WhatsAppContentFlags,
): Effect.Effect<
  Readonly<Record<string, unknown>>,
  CliUsageError | SamvaCliError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const sources = chosenSources(flags);
    if (sources.length > 1) {
      return yield* usage(
        "multiple_content_sources",
        `Provide exactly one content source; got ${sources.join(" and ")}.`,
      );
    }
    const orphan = orphanedCompanion(flags, sources);
    if (orphan !== undefined) return yield* orphan;
    if (sources.length === 0) {
      return yield* usage("missing_content", `Provide one content source: ${SOURCE_FLAGS}.`);
    }

    if (flags.text !== undefined) {
      if (flags.text.trim().length === 0)
        return yield* usage("empty_text", "--text must not be empty.");
      return { text: flags.text };
    }
    if (flags.template !== undefined) {
      if (flags.template.trim().length === 0) {
        return yield* usage("empty_template", "--template must not be empty.");
      }
      return whatsappTemplateContent(
        flags.template,
        yield* parseWhatsappTemplateData(flags.data),
        flags.flowToken,
      );
    }
    if (flags.content !== undefined) {
      return yield* readWhatsappContentSource(flags.content).pipe(
        Effect.flatMap(parseWhatsappContent),
      );
    }
    if (flags.mediaUrl !== undefined) {
      if (flags.mediaType === undefined) {
        return yield* usage(
          "missing_media_type",
          `--media-url requires --media-type: ${WHATSAPP_MEDIA_TYPES.join(", ")}.`,
        );
      }
      if (flags.caption !== undefined && !CAPTIONED.includes(flags.mediaType)) {
        return yield* usage(
          "caption_not_supported",
          `--caption applies to ${CAPTIONED.join(", ")} media, not ${flags.mediaType}.`,
        );
      }
      if (flags.filename !== undefined && flags.mediaType !== "document") {
        return yield* usage("filename_not_supported", "--filename applies to document media only.");
      }
      return whatsappMediaContent({
        url: flags.mediaUrl,
        type: flags.mediaType,
        caption: flags.caption,
        filename: flags.filename,
      });
    }
    if (flags.flow !== undefined) {
      if (flags.flow.trim().length === 0) {
        return yield* usage("empty_flow", "--flow must be a flow id (waflow_…).");
      }
      if (flags.cta === undefined || flags.cta.trim().length === 0) {
        return yield* usage("missing_cta", "--flow requires --cta with the button label.");
      }
      if (flags.body === undefined || flags.body.trim().length === 0) {
        return yield* usage("missing_body", "--flow requires --body with the message text.");
      }
      if (flags.flowData !== undefined && flags.flowScreen === undefined) {
        return yield* usage(
          "flow_data_without_screen",
          "--flow-data needs --flow-screen, the screen that reads it.",
        );
      }
      if (
        flags.flowAction === "data_exchange" &&
        (flags.flowScreen !== undefined || flags.flowData !== undefined)
      ) {
        return yield* usage(
          "flow_data_exchange_with_screen",
          "--flow-action data_exchange takes no --flow-screen or --flow-data; the flow's endpoint answers the first screen.",
        );
      }
      return whatsappFlowContent({
        flowId: flags.flow,
        cta: flags.cta,
        body: flags.body,
        footer: flags.footer,
        token: flags.flowToken,
        action: flags.flowAction,
        screen: flags.flowScreen,
        data: yield* parseWhatsappFlowData(flags.flowData),
      });
    }
    if (flags.react !== undefined) {
      if (flags.emoji === undefined || flags.emoji.trim().length === 0) {
        return yield* usage("missing_emoji", "--react requires --emoji with one emoji.");
      }
      return whatsappReactionContent(flags.react, flags.emoji);
    }
    if (flags.body === undefined || flags.body.trim().length === 0) {
      return yield* usage(
        "missing_body",
        "Reply buttons need --body with the message text and 1 to 3 --button id:Title.",
      );
    }
    if (flags.buttons.length < 1 || flags.buttons.length > 3) {
      return yield* usage(
        "invalid_button_count",
        `Reply buttons take 1 to 3 --button id:Title; got ${String(flags.buttons.length)}.`,
      );
    }
    const buttons = yield* Effect.forEach(flags.buttons, parseWhatsappButton);
    return whatsappButtonsContent({ body: flags.body, footer: flags.footer, buttons });
  });
