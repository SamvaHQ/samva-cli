import {
  CreatedWhatsAppSetupLink,
  WHATSAPP_SETUP_LINK_STATUS_VALUES,
  WhatsAppSetupLink,
} from "@samva/core/whatsapp/setup-link";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";

import { CliUsageError, SamvaCliError, toCliApiError } from "../errors";
import { getAuthenticatedJson, postAuthenticatedJson } from "../lib/client";
import { confirmDestructive } from "../lib/confirm";
import { jsonFlag, printFields, printJson } from "../lib/output";

/**
 * `samva whatsapp setup-links create | list | get | revoke` — hosted links a platform hands its
 * own customer to connect a WhatsApp number into a namespace, without a Samva account.
 *
 * The setup-links API is hidden (served while the `whatsapp` launch flag is on, absent from the
 * public SDK), so the commands call it directly with the CLI's credentials, as the flows commands
 * do. A namespace-scoped key is confined to its namespace by the API.
 */

/** Links as the API wire carries them: dates stay ISO strings. */
const WireSetupLink = Schema.toEncoded(WhatsAppSetupLink);
export type WireSetupLink = typeof WireSetupLink.Type;
const WireCreatedSetupLink = Schema.toEncoded(CreatedWhatsAppSetupLink);
export type WireCreatedSetupLink = typeof WireCreatedSetupLink.Type;
const WireSetupLinkPage = Schema.Struct({
  items: Schema.Array(WireSetupLink),
  nextCursor: Schema.NullOr(Schema.String),
});

const linkIdArgument = Argument.String("link-id").pipe(
  Argument.withDescription("Setup link id (wasl_…), from `samva whatsapp setup-links list`"),
);

/** The setup links collection, or one link and its action. */
export const setupLinksPath = (linkId?: string, action?: "revoke"): string => {
  const base = "/v1/whatsapp/setup-links";
  if (linkId === undefined) return base;
  const one = `${base}/${encodeURIComponent(linkId)}`;
  return action === undefined ? one : `${one}/${action}`;
};

/** The list path with its filters; unset filters are left out. */
export const listSetupLinksPath = (query: {
  readonly namespaceId?: string | undefined;
  readonly status?: string | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}): string => {
  const params = new URLSearchParams();
  if (query.namespaceId !== undefined) params.set("namespaceId", query.namespaceId);
  if (query.status !== undefined) params.set("status", query.status);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  const search = params.toString();
  return search === "" ? setupLinksPath() : `${setupLinksPath()}?${search}`;
};

/** The create payload: optional fields only when given. */
export const createSetupLinkPayload = (input: {
  readonly namespaceId: string;
  readonly redirectUrl?: string | undefined;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
  readonly expiresAt?: string | undefined;
}) => ({
  namespaceId: input.namespaceId,
  ...(input.redirectUrl === undefined ? {} : { redirectUrl: input.redirectUrl }),
  ...(input.metadata === undefined || Object.keys(input.metadata).length === 0
    ? {}
    : { metadata: input.metadata }),
  ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
});

/** Parse `key=value` pairs; the first `=` separates the key, so a value may contain `=`. */
export const parseMetadataPairs = (raw: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const metadata: Record<string, string> = {};
    for (const pair of raw) {
      const at = pair.indexOf("=");
      if (at <= 0) {
        return yield* new CliUsageError({
          code: "invalid_metadata",
          message: `--metadata must be key=value, got "${pair}".`,
        });
      }
      metadata[pair.slice(0, at)] = pair.slice(at + 1);
    }
    return metadata;
  });

const SETUP_LINK_NEXT: Readonly<Record<string, string>> = {
  WhatsAppSetupLinkUnavailableError:
    "Only a pending link can be revoked. A link that connected a number, was revoked, or expired is final; create a new link.",
  ResourceNotFoundError:
    "Check the ids: `samva whatsapp setup-links list` shows links, and `samva namespaces list` shows namespaces.",
  ValidationError:
    "Read the reason in the message: the redirect URL must be an absolute https URL, the expiry at most 30 days ahead, and metadata plain string values.",
  ForbiddenError: "The API key cannot create or read setup links for that namespace.",
  FlagDisabledError: "WhatsApp is not enabled for this organization.",
};

/** A failed setup-links call with the recovery step that names the cause. */
export const setupLinkError =
  (what: string) =>
  (error: unknown): SamvaCliError => {
    const failure = toCliApiError(`Could not ${what}`, error);
    const next = failure.api === undefined ? undefined : SETUP_LINK_NEXT[failure.api.reason];
    return next === undefined || failure.api === undefined
      ? failure
      : new SamvaCliError({
          message: failure.message,
          api: { ...failure.api, next },
          details: failure.details,
        });
  };

/** The labelled lines one link prints in human mode. */
export const setupLinkFields = (link: WireSetupLink): ReadonlyArray<readonly [string, unknown]> => [
  ["Setup link ID", link.id],
  ["Namespace", link.namespaceId],
  ["Status", link.status],
  ["Expires", link.expiresAt],
  ["Redirect URL", link.redirectUrl],
  ["Business account", link.businessAccountId],
  ["Completed", link.completedAt],
  ["Revoked", link.revokedAt],
  ["Created", link.createdAt],
  ...Object.entries(link.metadata).map(([key, value]) => [`Metadata ${key}`, value] as const),
];

const unreadable = (what: string) => () =>
  new SamvaCliError({ message: `The API answered with an unreadable ${what}.` });

const quiet = <A, E, R>(json: boolean, effect: Effect.Effect<A, E, R>) =>
  json ? Effect.provideService(effect, References.MinimumLogLevel, "None") : effect;

const decodeLink = (body: unknown) =>
  Schema.decodeUnknownEffect(WireSetupLink)(body).pipe(Effect.mapError(unreadable("setup link")));

const create = Command.make("create", {
  namespace: Flag.String("namespace").pipe(
    Flag.withDescription("Namespace (ns_…) the connected number joins"),
  ),
  redirectUrl: Flag.String("redirect-url").pipe(
    Flag.withDescription("Absolute https URL the hosted page sends your customer to afterwards"),
    Flag.optional,
  ),
  metadata: Flag.String("metadata").pipe(
    Flag.withDescription(
      "Your own label, key=value (repeatable); returned on the link and the whatsapp.number.connected event",
    ),
    Flag.withMetavar("key=value"),
    Flag.atLeast(0),
  ),
  expiresAt: Flag.String("expires-at").pipe(
    Flag.withDescription(
      "ISO 8601 instant the link stops working; at most 30 days ahead, 7 days when omitted",
    ),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Create a single-use link your customer opens to connect their WhatsApp number into a namespace. The URL is shown once.",
  ),
  Command.withExamples([
    {
      command:
        "samva whatsapp setup-links create --namespace ns_abc123 --metadata customer=acme --redirect-url https://app.example.com/connected",
      description: "Create a link for one of your customers and keep the printed URL",
    },
  ]),
  Command.withHandler(({ namespace, redirectUrl, metadata, expiresAt, json }) =>
    quiet(
      json,
      Effect.gen(function* () {
        const pairs = yield* parseMetadataPairs(metadata);
        const expires = Option.getOrUndefined(expiresAt);
        if (expires !== undefined && Number.isNaN(Date.parse(expires))) {
          return yield* new CliUsageError({
            code: "invalid_expires_at",
            message: `--expires-at must be an ISO 8601 instant such as 2027-01-01T00:00:00Z, got "${expires}".`,
          });
        }
        const body = yield* postAuthenticatedJson(setupLinksPath(), {
          body: createSetupLinkPayload({
            namespaceId: namespace,
            redirectUrl: Option.getOrUndefined(redirectUrl),
            metadata: pairs,
            expiresAt: expires,
          }),
        }).pipe(Effect.mapError(setupLinkError("create the setup link")));
        const link = yield* Schema.decodeUnknownEffect(WireCreatedSetupLink)(body).pipe(
          Effect.mapError(unreadable("setup link")),
        );
        if (json) return yield* printJson(link);
        yield* Effect.logInfo("Setup link created.\n");
        yield* Console.log(link.url);
        yield* Console.log("");
        yield* printFields(setupLinkFields(link));
        yield* Console.log(
          "\nThis URL is shown once; Samva keeps only a digest of its token. Send it to your customer now.",
        );
      }),
    ),
  ),
);

const list = Command.make("list", {
  namespace: Flag.String("namespace").pipe(
    Flag.withDescription("Only links for this namespace (ns_…)"),
    Flag.optional,
  ),
  status: Flag.Literals("status", WHATSAPP_SETUP_LINK_STATUS_VALUES).pipe(
    Flag.withDescription(
      `Only links in this state: ${WHATSAPP_SETUP_LINK_STATUS_VALUES.join(", ")}`,
    ),
    Flag.optional,
  ),
  limit: Flag.Int("limit").pipe(Flag.withDescription("Links per page"), Flag.optional),
  cursor: Flag.String("cursor").pipe(
    Flag.withDescription("Resume after this nextCursor from a previous page"),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List WhatsApp setup links, newest first"),
  Command.withExamples([
    {
      command: "samva whatsapp setup-links list --namespace ns_abc123 --status pending",
      description: "See the links still waiting for a customer",
    },
  ]),
  Command.withHandler(({ namespace, status, limit, cursor, json }) =>
    quiet(
      json,
      Effect.gen(function* () {
        const body = yield* getAuthenticatedJson(
          listSetupLinksPath({
            namespaceId: Option.getOrUndefined(namespace),
            status: Option.getOrUndefined(status),
            limit: Option.getOrUndefined(limit),
            cursor: Option.getOrUndefined(cursor),
          }),
        ).pipe(Effect.mapError(setupLinkError("list setup links")));
        const page = yield* Schema.decodeUnknownEffect(WireSetupLinkPage)(body).pipe(
          Effect.mapError(unreadable("list")),
        );
        if (json) return yield* printJson(page);
        if (page.items.length === 0) {
          yield* Effect.logInfo(
            "No setup links. Create one with `samva whatsapp setup-links create --namespace <id>`.",
          );
          return;
        }
        for (const link of page.items) {
          yield* printFields(setupLinkFields(link));
          yield* Console.log("");
        }
        if (page.nextCursor !== null) yield* printFields([["Next cursor", page.nextCursor]]);
      }),
    ),
  ),
);

const get = Command.make("get", { id: linkIdArgument, json: jsonFlag }).pipe(
  Command.withDescription("Get one setup link (its URL is not retrievable after creation)"),
  Command.withExamples([
    { command: "samva whatsapp setup-links get wasl_abc123", description: "Read a link's status" },
  ]),
  Command.withHandler(({ id, json }) =>
    quiet(
      json,
      Effect.gen(function* () {
        const body = yield* getAuthenticatedJson(setupLinksPath(id)).pipe(
          Effect.mapError(setupLinkError("get the setup link")),
        );
        const link = yield* decodeLink(body);
        if (json) return yield* printJson(link);
        yield* printFields(setupLinkFields(link));
      }),
    ),
  ),
);

const revoke = Command.make("revoke", {
  id: linkIdArgument,
  yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Revoke a pending setup link so it can no longer connect a number. A link that connected, was revoked, or expired answers 410.",
  ),
  Command.withExamples([
    {
      command: "samva whatsapp setup-links revoke wasl_abc123 --yes",
      description: "Stop a pending link",
    },
  ]),
  Command.withHandler(({ id, yes, json }) =>
    quiet(
      json,
      Effect.gen(function* () {
        yield* confirmDestructive({
          yes,
          json,
          message: `Revoke setup link ${id}? Your customer can no longer use it, and a new link must be sent.`,
          nonInteractiveMessage: "Revoking a setup link requires --yes in non-interactive mode.",
        });
        const body = yield* postAuthenticatedJson(setupLinksPath(id, "revoke"), {
          body: {},
        }).pipe(Effect.mapError(setupLinkError("revoke the setup link")));
        const link = yield* decodeLink(body);
        if (json) return yield* printJson(link);
        yield* Effect.logInfo("Setup link revoked.\n");
        yield* printFields(setupLinkFields(link));
      }),
    ),
  ),
);

export const setupLinks = Command.make("setup-links").pipe(
  Command.withDescription(
    "Create and manage hosted links that connect a customer's WhatsApp number into a namespace",
  ),
  Command.withSubcommands([create, list, get, revoke]),
);
