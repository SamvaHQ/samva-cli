import { Console, Effect, Option, Redacted } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import * as Namespaces from "samva/effect/namespaces";

import { CliUsageError } from "../errors";
import { yesFlag } from "../lib/confirm";
import { deriveOverride } from "../lib/derive/curated";
import { jsonFlag, printFields } from "../lib/output";

const namespace = Argument.String("namespace-id").pipe(
  Argument.withDescription("Namespace id (ns_…)"),
);
const dryRunFlag = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Print the planned change without calling the API"),
  Flag.withDefault(false),
);
type PortalLink = Effect.Success<ReturnType<typeof Namespaces.listPortalLinks>>["items"][number];
const fields = (link: PortalLink): ReadonlyArray<readonly [string, unknown]> => [
  ["Portal link ID", link.id],
  ["Namespace", link.namespaceId],
  ["Expires", link.expiresAt],
  ["Revoked", link.revokedAt],
  ["Redirect URL", link.redirectUrl],
  ["Created", link.createdAt],
  ...Object.entries(link.metadata).map(([key, value]) => [`Metadata ${key}`, value] as const),
];

const create = deriveOverride(
  "create",
  {
    id: namespace,
    redirectUrl: Flag.String("redirect-url").pipe(
      Flag.withDescription("HTTPS URL to return your customer to"),
      Flag.optional,
    ),
    expiresIn: Flag.Int("expires-in").pipe(
      Flag.withDescription(
        "Link lifetime in seconds; see the portal link API reference for bounds",
      ),
      Flag.optional,
    ),
    metadata: Flag.String("metadata").pipe(
      Flag.withDescription("Your label as key=value (repeatable)"),
      Flag.atLeast(0),
    ),
    dryRun: dryRunFlag,
    json: jsonFlag,
  },
  {
    prepare: ({ id, redirectUrl, expiresIn, metadata }) =>
      Effect.gen(function* () {
        const labels: Record<string, string> = {};
        for (const pair of metadata) {
          const at = pair.indexOf("=");
          if (at <= 0)
            return yield* new CliUsageError({
              code: "invalid_metadata",
              message: `--metadata must be key=value, got "${pair}".`,
            });
          labels[pair.slice(0, at)] = pair.slice(at + 1);
        }
        return {
          id,
          redirectUrl: Option.getOrUndefined(redirectUrl),
          expiresIn: Option.getOrUndefined(expiresIn),
          ...(metadata.length === 0 ? {} : { metadata: labels }),
        };
      }),
    call: (request) => Namespaces.createPortalLink(request),
    failure: "Could not create portal link",
    preview: {
      data: (request) => ({ dryRun: true, action: "namespaces.createPortalLink", request }),
      render: (request) =>
        printFields([
          ["Action", "namespaces.createPortalLink"],
          ["Namespace", request.id],
          ["Redirect URL", request.redirectUrl],
          ["Expires in", request.expiresIn],
        ]),
    },
    mapOutput: (link) => ({ ...link, url: Redacted.value(link.url) }),
    render: (link) =>
      Effect.gen(function* () {
        yield* Console.log(Redacted.value(link.url));
        yield* printFields(fields(link));
        yield* Console.error(
          "This URL is shown once. Anyone holding it can open this namespace's portal; share it privately.",
        );
      }),
  },
).pipe(
  Command.withDescription(
    "Create a customer portal link with organization-wide authority; its URL is shown once",
  ),
  Command.withExamples([
    {
      command:
        "samva namespaces portal-links create ns_7q2xk9mvt4znw8rh --redirect-url https://app.example.com/settings --metadata customer=acme --json",
    },
  ]),
);

const list = deriveOverride(
  "list",
  {
    id: namespace,
    cursor: Flag.String("cursor").pipe(
      Flag.withDescription("Resume after the previous nextCursor"),
      Flag.optional,
    ),
    limit: Flag.Int("limit").pipe(Flag.withDescription("Links per page"), Flag.optional),
    json: jsonFlag,
  },
  {
    mapInput: ({ id, cursor, limit }) => ({
      id,
      cursor: Option.getOrUndefined(cursor),
      limit: Option.getOrUndefined(limit),
    }),
    call: (request) => Namespaces.listPortalLinks(request),
    failure: "Could not list portal links",
    render: (page) =>
      Effect.gen(function* () {
        if (page.items.length === 0)
          return yield* Console.log("No portal links for this namespace.");
        for (const link of page.items) {
          yield* printFields(fields(link));
          yield* Console.log("");
        }
        if (page.nextCursor !== null) yield* printFields([["Next cursor", page.nextCursor]]);
      }),
  },
).pipe(
  Command.withDescription("List portal links for a namespace; secret URLs are never returned"),
  Command.withExamples([
    { command: "samva namespaces portal-links list ns_7q2xk9mvt4znw8rh --json" },
  ]),
);

const revoke = deriveOverride(
  "revoke",
  {
    id: namespace,
    linkId: Argument.String("link-id").pipe(Argument.withDescription("Portal link id (npl_…)")),
    yes: yesFlag(),
    dryRun: dryRunFlag,
    json: jsonFlag,
  },
  {
    mapInput: ({ id, linkId }) => ({ id, linkId }),
    call: (request) => Namespaces.revokePortalLink(request),
    failure: "Could not revoke portal link",
    preview: {
      data: (request) => ({
        dryRun: true,
        action: "namespaces.revokePortalLink",
        id: request.id,
        linkId: request.linkId,
      }),
      render: (request) =>
        Console.log(
          `[dry-run] Would revoke portal link ${request.linkId} in namespace ${request.id}.`,
        ),
    },
    confirmation: (request) => ({
      message: `Revoke portal link ${request.linkId}? Its customers lose portal access.`,
      nonInteractiveMessage:
        "Revoking a portal link requires --yes outside a terminal. Preview with --dry-run.",
    }),
    render: (link) => printFields(fields(link)),
  },
).pipe(
  Command.withDescription("Revoke a portal link and end its live sessions"),
  Command.withExamples([
    {
      command:
        "samva namespaces portal-links revoke ns_7q2xk9mvt4znw8rh npl_7q2xk9mvt4znw8rh --yes --json",
    },
  ]),
);

export const namespacePortalLinks = Command.make("portal-links").pipe(
  Command.withDescription("Give your customer a hosted portal for one namespace"),
  Command.withSubcommands([create, list, revoke]),
);
