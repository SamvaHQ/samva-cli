import { Console, Effect, Option, Redacted, References } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import * as Namespaces from "samva/effect/namespaces";

import { CliUsageError, toCliApiError } from "../errors";
import { getClientProvider } from "../lib/client";
import { confirmDestructive } from "../lib/confirm";
import { jsonFlag, printFields, printJson } from "../lib/output";

const namespace = Argument.String("namespace-id").pipe(
  Argument.withDescription("Namespace id (ns_…)"),
);
const dryRunFlag = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Print the planned change without calling the API"),
  Flag.withDefault(false),
);
const quiet = <A, E, R>(json: boolean, effect: Effect.Effect<A, E, R>) =>
  json ? Effect.provideService(effect, References.MinimumLogLevel, "None") : effect;
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

const create = Command.make("create", {
  id: namespace,
  redirectUrl: Flag.String("redirect-url").pipe(
    Flag.withDescription("HTTPS URL to return your customer to"),
    Flag.optional,
  ),
  expiresIn: Flag.Int("expires-in").pipe(
    Flag.withDescription("Link lifetime in seconds; see the portal link API reference for bounds"),
    Flag.optional,
  ),
  metadata: Flag.String("metadata").pipe(
    Flag.withDescription("Your label as key=value (repeatable)"),
    Flag.atLeast(0),
  ),
  dryRun: dryRunFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Create a customer portal link with organization-wide authority; its URL is shown once",
  ),
  Command.withExamples([
    {
      command:
        "samva namespaces portal-links create ns_7q2xk9mvt4znw8rh --redirect-url https://app.example.com/settings --metadata customer=acme --json",
    },
  ]),
  Command.withHandler(({ id, redirectUrl, expiresIn, metadata, dryRun, json }) =>
    quiet(
      json,
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
        const request = {
          id,
          redirectUrl: Option.getOrUndefined(redirectUrl),
          expiresIn: Option.getOrUndefined(expiresIn),
          ...(metadata.length === 0 ? {} : { metadata: labels }),
        };
        if (dryRun)
          return yield* json
            ? printJson({ dryRun: true, action: "namespaces.createPortalLink", request })
            : printFields([
                ["Action", "namespaces.createPortalLink"],
                ["Namespace", id],
                ["Redirect URL", request.redirectUrl],
                ["Expires in", request.expiresIn],
              ]);
        const client = yield* getClientProvider;
        const link = yield* Namespaces.createPortalLink(request).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError("Could not create portal link", error)),
        );
        const url = Redacted.value(link.url);
        if (json) return yield* printJson({ ...link, url });
        yield* Console.log(url);
        yield* printFields(fields(link));
        yield* Console.error(
          "This URL is shown once. Anyone holding it can open this namespace's portal; share it privately.",
        );
      }),
    ),
  ),
);

const list = Command.make("list", {
  id: namespace,
  cursor: Flag.String("cursor").pipe(
    Flag.withDescription("Resume after the previous nextCursor"),
    Flag.optional,
  ),
  limit: Flag.Int("limit").pipe(Flag.withDescription("Links per page"), Flag.optional),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List portal links for a namespace; secret URLs are never returned"),
  Command.withExamples([
    { command: "samva namespaces portal-links list ns_7q2xk9mvt4znw8rh --json" },
  ]),
  Command.withHandler(({ id, cursor, limit, json }) =>
    quiet(
      json,
      Effect.gen(function* () {
        const client = yield* getClientProvider;
        const page = yield* Namespaces.listPortalLinks({
          id,
          cursor: Option.getOrUndefined(cursor),
          limit: Option.getOrUndefined(limit),
        }).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError("Could not list portal links", error)),
        );
        if (json) return yield* printJson(page);
        if (page.items.length === 0)
          return yield* Console.log("No portal links for this namespace.");
        for (const link of page.items) {
          yield* printFields(fields(link));
          yield* Console.log("");
        }
        if (page.nextCursor !== null) yield* printFields([["Next cursor", page.nextCursor]]);
      }),
    ),
  ),
);

const revoke = Command.make("revoke", {
  id: namespace,
  linkId: Argument.String("link-id").pipe(Argument.withDescription("Portal link id (npl_…)")),
  yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
  dryRun: dryRunFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Revoke a portal link and end its live sessions"),
  Command.withExamples([
    {
      command:
        "samva namespaces portal-links revoke ns_7q2xk9mvt4znw8rh npl_7q2xk9mvt4znw8rh --yes --json",
    },
  ]),
  Command.withHandler(({ id, linkId, yes, dryRun, json }) =>
    quiet(
      json,
      Effect.gen(function* () {
        if (dryRun)
          return yield* json
            ? printJson({ dryRun: true, action: "namespaces.revokePortalLink", id, linkId })
            : Console.log(`[dry-run] Would revoke portal link ${linkId} in namespace ${id}.`);
        yield* confirmDestructive({
          yes,
          json,
          message: `Revoke portal link ${linkId}? Its customers lose portal access.`,
          nonInteractiveMessage:
            "Revoking a portal link requires --yes outside a terminal. Preview with --dry-run.",
        });
        const client = yield* getClientProvider;
        const link = yield* Namespaces.revokePortalLink({ id, linkId }).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError("Could not revoke portal link", error)),
        );
        if (json) return yield* printJson(link);
        yield* printFields(fields(link));
      }),
    ),
  ),
);

export const namespacePortalLinks = Command.make("portal-links").pipe(
  Command.withDescription("Give your customer a hosted portal for one namespace"),
  Command.withSubcommands([create, list, revoke]),
);
