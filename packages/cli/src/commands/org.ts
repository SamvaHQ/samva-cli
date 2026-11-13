import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as References from "effect/References";
import * as Organizations from "samva/effect/organizations";
import * as Whoami from "samva/effect/whoami";

import {
  type ExecutionContext,
  readConfig,
  resolveExecutionContext,
  writeConfig,
} from "../config/store";
import { CliAuthError, SamvaCliError, toCliApiError } from "../errors";
import { getClientProvider, getClientProviderForContext } from "../lib/client";
import { AGENT_AUTH_HINT } from "../lib/examples";
import { listOrganizations } from "../lib/oauth";
import { jsonFlag, printFields, printJson } from "../lib/output";
import { printResult } from "../lib/output";
import { orgAvatarCommand } from "./org-avatar";
import { orgInviteCommand } from "./org-invite";
import { usageCommand } from "./usage";

const list = Command.make("list", { json: jsonFlag }).pipe(
  Command.withDescription(
    "List the organizations you can access (multi-org under OAuth; single org under API key)",
  ),
  Command.withExamples([
    {
      command: "samva org list",
      description: "List orgs (OAuth) or show API-key org",
    },
    { command: "samva org list --json", description: "Machine-readable org list" },
  ]),
  Command.withHandler(({ json }) =>
    Effect.gen(function* () {
      // Resolve the execution context once — reading the OS keyring spawns a
      // subprocess, so a single resolve serves the token, API URL, and marker.
      const context = yield* resolveExecutionContext;
      // Under OAuth login the token is user-scoped, so list every org the user
      // belongs to (no active org required). API keys are bound to one org.
      if (context.credentials) {
        const orgs = yield* listOrganizations(context.apiUrl, context.credentials.accessToken);
        if (json) return yield* printJson(orgs);
        if (orgs.length === 0) {
          return yield* Console.log("You are not a member of any organizations yet.");
        }
        const lines = orgs.map((org) => {
          // The marker reports the profile's configured org, so a one-shot
          // --org/SAMVA_ORG override never restars a different row.
          const marker = org.slug === context.profileOrgSlug ? "* " : "  ";
          return `${marker}${org.slug}  ${org.name}`;
        });
        yield* Console.log(lines.join("\n"));
        return yield* Effect.logInfo("\nSet the active organization with `samva org use <slug>`.");
      }

      const client = yield* getClientProvider;
      const data = yield* Organizations.get().pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not load organization", error)),
      );
      if (json) return yield* printJson([data]);
      yield* printFields([
        ["Name", data.name],
        ["Slug", data.slug],
        ["ID", data.id],
        ["Plan", data.plan],
      ]);
      yield* Effect.logInfo(
        "\nNote: an API key is scoped to a single organization. Run `samva login` for multi-org access.",
      );
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const use = Command.make("use", { slug: Argument.String("slug") }).pipe(
  Command.withDescription(
    "Set the active organization for OAuth sessions (ignored when using SAMVA_API_KEY)",
  ),
  Command.withExamples([
    {
      command: "samva org use my-org-slug",
      description: "Set active org after samva login",
    },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ slug }) {
      const config = yield* readConfig;
      const context = yield* resolveExecutionContext;
      if (context.apiKey) {
        return yield* new CliAuthError({
          code: "api_key_org_override",
          message:
            "samva org use is unavailable with SAMVA_API_KEY; API keys are organization-scoped.",
        });
      }
      const current = config.profiles[context.profile] ?? { credentialIdentity: "none" as const };
      yield* writeConfig({
        ...config,
        profiles: { ...config.profiles, [context.profile]: { ...current, orgSlug: slug } },
      });
      yield* printResult({ action: "org.use", slug }, `Active organization set to "${slug}".`);
    }),
  ),
);

/** Read the resolved organization instead of deriving a mail domain from its mutable slug. */
const currentOrganization = (context: ExecutionContext) =>
  Effect.gen(function* () {
    const client = yield* getClientProviderForContext(context);
    return yield* Whoami.get().pipe(
      client.provide,
      Effect.mapError((error) => {
        const failure = toCliApiError("Could not look up the organization", error);
        return new SamvaCliError({
          message: `Could not look up the organization. ${failure.message}`,
          api: failure.api,
        });
      }),
    );
  });

const current = Command.make("current", { json: jsonFlag }).pipe(
  Command.withDescription("Show the active organization and its hosted mail domain"),
  Command.withExamples([
    { command: "samva org current", description: "Show the active org and hosted mail domain" },
    {
      command: "samva org current --json",
      description: 'JSON: { "activeOrgSlug": "...", "organization": {...}, "credential": {...} }',
    },
  ]),
  Command.withHandler(({ json }) =>
    Effect.gen(function* () {
      const context = yield* resolveExecutionContext;
      if (!context.apiKey && !context.orgSlug) {
        return yield* new CliAuthError({
          code: "missing_organization",
          message: "No active organization set. Run `samva org use <slug>` or `samva org list`.",
        });
      }
      const caller = yield* currentOrganization(context);
      if (!json) {
        return yield* printFields([
          ["Slug", caller.organization.slug],
          ["Hosted mail domain", caller.organization.hostedMailDomain],
        ]);
      }
      const credential = caller.credential;
      return yield* printJson({
        activeOrgSlug: caller.organization.slug,
        organization: caller.organization,
        credential:
          credential.type === "apiKey"
            ? { type: credential.type, id: credential.id, name: credential.name }
            : { type: credential.type, id: credential.user.id, name: credential.user.name },
      });
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

export const orgCommand = Command.make("org").pipe(
  Command.withDescription(`Manage organizations. ${AGENT_AUTH_HINT}`),
  Command.withExamples([
    { command: "samva org list", description: "List accessible organizations" },
    { command: "samva org use my-org-slug", description: "Set active org (OAuth)" },
  ]),
  Command.withSubcommands([list, use, current, orgInviteCommand, orgAvatarCommand, usageCommand]),
);
