import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Domains from "samva/effect/newsletter-domains";
import * as Newsletters from "samva/effect/newsletters";

import { toCliApiError } from "../errors";
import { getClientProvider } from "../lib/client";
import { confirmDestructive } from "../lib/confirm";
import { jsonFlag, printJsonDocument } from "../lib/output";
import { issuesCommand } from "./newsletter-issues";
const idArgument = Argument.String("newsletter-id").pipe(
  Argument.withDescription("Newsletter id (nl_...)"),
);
const optional = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.optional);
const dryRunFlag = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Preview without calling the API"),
  Flag.withDefault(false),
);
const key = optional("idempotency-key", "Reuse for the same logical request");
const settings = {
  archive: Flag.Literals("archive", ["enabled", "disabled"]).pipe(
    Flag.withDescription("Publish sent issues in the public archive"),
    Flag.optional,
  ),
  slug: optional("publication-slug", "Hosted samva.app label; none clears it"),
};
const settingsInput = (
  archive: Option.Option<"enabled" | "disabled">,
  slug: Option.Option<string>,
) => ({
  archiveEnabled: Option.map(archive, (value) => value === "enabled").pipe(Option.getOrUndefined),
  publicationSlug: Option.match(slug, {
    onNone: () => undefined,
    onSome: (value) => (value === "none" ? null : value),
  }),
});
const list = Command.make("list", {
  namespaceId: optional("namespace-id", "Limit to a namespace"),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List newsletters"),
  Command.withHandler(
    Effect.fnUntraced(function* ({ namespaceId }) {
      const client = yield* getClientProvider;
      yield* printJsonDocument(
        yield* Newsletters.list({ namespaceId: Option.getOrUndefined(namespaceId) }).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError("Could not list newsletters", error)),
        ),
      );
    }),
  ),
);
const get = Command.make("get", { id: idArgument, json: jsonFlag }).pipe(
  Command.withDescription("Read a newsletter"),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id }) {
      const client = yield* getClientProvider;
      yield* printJsonDocument(
        yield* Newsletters.get({ id }).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError("Could not read newsletter", error)),
        ),
      );
    }),
  ),
);
const create = Command.make("create", {
  name: optional("name", "Name when creating a topic"),
  topicId: optional("topic-id", "Adopt an existing consent topic"),
  namespaceId: optional("namespace-id", "Namespace for the new topic"),
  description: optional("description", "Description of the new topic"),
  ...settings,
  idempotencyKey: key,
  dryRun: dryRunFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create a newsletter and opt-in topic, or adopt an existing topic"),
  Command.withHandler(
    Effect.fnUntraced(function* ({
      name,
      topicId,
      namespaceId,
      description,
      archive,
      slug,
      idempotencyKey,
      dryRun,
    }) {
      const request = {
        name: Option.getOrUndefined(name),
        topicId: Option.getOrUndefined(topicId),
        namespaceId: Option.getOrUndefined(namespaceId),
        description: Option.getOrUndefined(description),
        ...settingsInput(archive, slug),
      };
      if (dryRun)
        return yield* printJsonDocument({ dryRun, action: "newsletters.create", request });
      const client = yield* getClientProvider;
      yield* printJsonDocument(
        yield* Newsletters.create(request, {
          idempotencyKey: Option.getOrUndefined(idempotencyKey),
        }).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError("Could not create newsletter", error)),
        ),
      );
    }),
  ),
);
const update = Command.make("update", {
  id: idArgument,
  ...settings,
  idempotencyKey: key,
  dryRun: dryRunFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Update newsletter publishing settings"),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, archive, slug, idempotencyKey, dryRun }) {
      const request = { id, ...settingsInput(archive, slug) };
      if (dryRun)
        return yield* printJsonDocument({ dryRun, action: "newsletters.update", request });
      const client = yield* getClientProvider;
      yield* printJsonDocument(
        yield* Newsletters.update(request, {
          idempotencyKey: Option.getOrUndefined(idempotencyKey),
        }).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError("Could not update newsletter", error)),
        ),
      );
    }),
  ),
);
const remove = Command.make("delete", {
  id: idArgument,
  idempotencyKey: key,
  dryRun: dryRunFlag,
  yes: Flag.Boolean("yes").pipe(Flag.withDescription("Confirm deletion"), Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Delete a newsletter and its issue repository, retaining its consent topic",
  ),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, idempotencyKey, dryRun, yes, json }) {
      const request = { id };
      if (dryRun)
        return yield* printJsonDocument({ dryRun, action: "newsletters.remove", request });
      yield* confirmDestructive({
        message: `Delete newsletter ${id}?`,
        yes,
        json,
        nonInteractiveMessage: "Pass --yes to delete the newsletter",
      });
      const client = yield* getClientProvider;
      yield* printJsonDocument(
        yield* Newsletters.remove(request, {
          idempotencyKey: Option.getOrUndefined(idempotencyKey),
        }).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError("Could not delete newsletter", error)),
        ),
      );
    }),
  ),
);
const hostnameArgument = Argument.String("hostname").pipe(
  Argument.withDescription("Custom archive hostname"),
);
const listDomains = Command.make("list", {
  id: idArgument,
  cursor: optional("cursor", "Resume after the previous page's nextCursor"),
  limit: Flag.Int("limit").pipe(Flag.withDescription("Items per page"), Flag.optional),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List newsletter domains"),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, cursor, limit }) {
      const client = yield* getClientProvider;
      yield* printJsonDocument(
        yield* Domains.list({
          id,
          cursor: Option.getOrUndefined(cursor),
          limit: Option.getOrUndefined(limit),
        }).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError("Could not list newsletter domains", error)),
        ),
      );
    }),
  ),
);
const addDomain = Command.make("add", {
  id: idArgument,
  hostname: hostnameArgument,
  idempotencyKey: key,
  dryRun: dryRunFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Add a newsletter domain"),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, hostname, idempotencyKey, dryRun }) {
      const request = { id, hostname };
      if (dryRun)
        return yield* printJsonDocument({ dryRun, action: "newsletterDomains.add", request });
      const client = yield* getClientProvider;
      yield* printJsonDocument(
        yield* Domains.add(request, { idempotencyKey: Option.getOrUndefined(idempotencyKey) }).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError("Could not add newsletter domain", error)),
        ),
      );
    }),
  ),
);
const getDomain = Command.make("get", {
  id: idArgument,
  hostname: hostnameArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Check newsletter domain verification"),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, hostname }) {
      const client = yield* getClientProvider;
      yield* printJsonDocument(
        yield* Domains.get({ id, hostname }).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError("Could not read newsletter domain", error)),
        ),
      );
    }),
  ),
);
const removeDomain = Command.make("remove", {
  id: idArgument,
  hostname: hostnameArgument,
  idempotencyKey: key,
  dryRun: dryRunFlag,
  yes: Flag.Boolean("yes").pipe(Flag.withDescription("Confirm removal"), Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Remove a newsletter domain"),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, hostname, idempotencyKey, dryRun, yes, json }) {
      const request = { id, hostname };
      if (dryRun)
        return yield* printJsonDocument({ dryRun, action: "newsletterDomains.remove", request });
      yield* confirmDestructive({
        message: `Remove newsletter domain ${hostname}?`,
        yes,
        json,
        nonInteractiveMessage: "Pass --yes to remove the domain",
      });
      const client = yield* getClientProvider;
      yield* printJsonDocument(
        yield* Domains.remove(request, {
          idempotencyKey: Option.getOrUndefined(idempotencyKey),
        }).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError("Could not remove newsletter domain", error)),
        ),
      );
    }),
  ),
);
export const newslettersCommand = Command.make("newsletters").pipe(
  Command.withDescription("Manage newsletters, issues and public archives"),
  Command.withSubcommands([
    list,
    get,
    create,
    update,
    remove,
    issuesCommand,
    Command.make("domains").pipe(
      Command.withDescription("Manage archive domains"),
      Command.withSubcommands([listDomains, addDomain, getDomain, removeDomain]),
    ),
  ]),
);
