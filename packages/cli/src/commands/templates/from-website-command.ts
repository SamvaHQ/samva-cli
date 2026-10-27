import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
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

/**
 * The dashboard origin for an API URL. The API serves from `api.<web host>` (`api.samva.dev`
 * beside `samva.dev`), so the web origin is the same URL without that label. A custom API URL
 * that does not follow the convention has no derivable dashboard, and the caller prints the path.
 */
export const webOriginForApi = (apiUrl: string): string | null => {
  if (!URL.canParse(apiUrl)) return null;
  const url = new URL(apiUrl);
  if (!url.hostname.startsWith("api.")) return null;
  url.hostname = url.hostname.slice("api.".length);
  return url.origin;
};

/** The dashboard editor path that opens a template with the assistant's first message prefilled. */
export const editorPath = (orgSlug: string, templateId: string, ask: string): string =>
  `/dashboard/${encodeURIComponent(orgSlug)}/templates/${encodeURIComponent(templateId)}/edit?ask=${encodeURIComponent(ask)}`;

const urlArgument = Argument.String("url").pipe(
  Argument.withDescription("The website to match: a public https address or a bare domain"),
);

export const fromWebsiteCommand = Command.make("from-website", {
  url: urlArgument,
  name: Flag.String("name").pipe(
    Flag.withDescription("Name for the new template; defaults to one derived from the site"),
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
    "Create a template project from a website, then open the editor to have the assistant match its brand",
  ),
  Command.withExamples([
    {
      command: "samva templates from-website example.com",
      description: "Check the site, create the project, and print the editor link",
    },
    {
      command: 'samva templates from-website https://example.com --name "Example welcome" --json',
      description: "Machine-readable result with the template, website, ask, and editor link",
    },
  ]),
  Command.withHandler(({ url, name, namespace, idempotencyKey, json }) =>
    Effect.gen(function* () {
      const key = Option.getOrUndefined(idempotencyKey);
      if (key !== undefined && (key.length < 1 || key.length > 255))
        return yield* new SamvaCliError({
          message: "--idempotency-key must contain between 1 and 255 characters.",
        });
      const client = yield* getClientProvider;
      const context = yield* resolveExecutionContext;
      // The organization slug builds the editor link. Resolve it before the write so a failure
      // here leaves nothing created.
      const orgSlug = context.apiKey
        ? (yield* Whoami.get().pipe(
            client.provide,
            Effect.mapError((error) => toCliApiError("Could not look up the organization", error)),
          )).organization.slug
        : context.orgSlug;
      const result = yield* Templates.createFromWebsite({
        url,
        ...(Option.isSome(name) ? { name: name.value } : {}),
        ...namespaceField(namespace),
        idempotencyKey: key ?? crypto.randomUUID(),
      }).pipe(
        client.provide,
        Effect.mapError((error) =>
          toCliApiError("Could not create a template from the website", error),
        ),
      );
      const path =
        orgSlug === undefined ? null : editorPath(orgSlug, result.template.id, result.ask);
      const origin = webOriginForApi(context.apiUrl);
      const editorUrl = path !== null && origin !== null ? `${origin}${path}` : null;
      if (json)
        return yield* printJson({
          template: { id: result.template.id, name: result.template.name },
          website: result.website,
          ask: result.ask,
          editorUrl,
        });
      yield* printFields([
        ["Template", result.template.id],
        ["Website", result.website.host],
        ...(editorUrl !== null
          ? ([["Editor", editorUrl]] as const)
          : ([["Ask", result.ask]] as const)),
      ]);
      yield* Console.log(
        editorUrl !== null
          ? "The brand proposal applies only when you approve it in the editor."
          : "Open the template in the dashboard editor and send the ask above; the brand proposal applies only when you approve it there.",
      );
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
