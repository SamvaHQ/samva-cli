import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Option from "effect/Option";
import * as Domains from "samva/effect/newsletter-domains";
import * as Newsletters from "samva/effect/newsletters";

import { deriveOverride } from "../lib/derive/curated";
import { jsonFlag } from "../lib/output";
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

const list = deriveOverride(
  "list",
  {
    namespaceId: optional("namespace", "Limit to a namespace"),
    json: jsonFlag,
  },
  {
    mapInput: (input) => ({ namespaceId: Option.getOrUndefined(input.namespaceId) }),
    call: (request) => Newsletters.list(request),
    failure: "Could not list newsletters",
    document: true,
  },
).pipe(Command.withDescription("List newsletters"));

const get = deriveOverride(
  "get",
  { id: idArgument, json: jsonFlag },
  {
    mapInput: (input) => ({ id: input.id }),
    call: (request) => Newsletters.get(request),
    failure: "Could not read newsletter",
    document: true,
  },
).pipe(Command.withDescription("Read a newsletter"));

const create = deriveOverride(
  "create",
  {
    name: optional("name", "Name when creating a topic"),
    topicId: optional("topic-id", "Adopt an existing consent topic"),
    namespaceId: optional("namespace", "Namespace for the new topic"),
    description: optional("description", "Description of the new topic"),
    ...settings,
    idempotencyKey: key,
    dryRun: dryRunFlag,
    json: jsonFlag,
  },
  {
    mapInput: (input) => ({
      name: Option.getOrUndefined(input.name),
      topicId: Option.getOrUndefined(input.topicId),
      namespaceId: Option.getOrUndefined(input.namespaceId),
      description: Option.getOrUndefined(input.description),
      ...settingsInput(input.archive, input.slug),
    }),
    call: (request, input) =>
      Newsletters.create(request, {
        idempotencyKey: Option.getOrUndefined(input.idempotencyKey),
      }),
    failure: "Could not create newsletter",
    preview: {
      data: (request) => ({ dryRun: true, action: "newsletters.create", request }),
    },
    document: true,
  },
).pipe(Command.withDescription("Create a newsletter and opt-in topic, or adopt an existing topic"));

const update = deriveOverride(
  "update",
  {
    id: idArgument,
    ...settings,
    idempotencyKey: key,
    dryRun: dryRunFlag,
    json: jsonFlag,
  },
  {
    mapInput: (input) => ({ id: input.id, ...settingsInput(input.archive, input.slug) }),
    call: (request, input) =>
      Newsletters.update(request, {
        idempotencyKey: Option.getOrUndefined(input.idempotencyKey),
      }),
    failure: "Could not update newsletter",
    preview: {
      data: (request) => ({ dryRun: true, action: "newsletters.update", request }),
    },
    document: true,
  },
).pipe(Command.withDescription("Update newsletter publishing settings"));

const remove = deriveOverride(
  "delete",
  {
    id: idArgument,
    idempotencyKey: key,
    dryRun: dryRunFlag,
    yes: Flag.Boolean("yes").pipe(
      Flag.withDescription("Confirm deletion"),
      Flag.withDefault(false),
    ),
    json: jsonFlag,
  },
  {
    mapInput: (input) => ({ id: input.id }),
    call: (request, input) =>
      Newsletters.remove(request, {
        idempotencyKey: Option.getOrUndefined(input.idempotencyKey),
      }),
    failure: "Could not delete newsletter",
    preview: {
      data: (request) => ({ dryRun: true, action: "newsletters.remove", request }),
    },
    confirmation: (request) => ({
      message: `Delete newsletter ${request.id}?`,
      nonInteractiveMessage: "Pass --yes to delete the newsletter",
    }),
    document: true,
  },
).pipe(
  Command.withDescription(
    "Delete a newsletter and its issue repository, retaining its consent topic",
  ),
);

const hostnameArgument = Argument.String("hostname").pipe(
  Argument.withDescription("Custom archive hostname"),
);

const listDomains = deriveOverride(
  "list",
  {
    id: idArgument,
    cursor: optional("cursor", "Resume after the previous page's nextCursor"),
    limit: Flag.Int("limit").pipe(Flag.withDescription("Items per page"), Flag.optional),
    json: jsonFlag,
  },
  {
    mapInput: (input) => ({
      id: input.id,
      cursor: Option.getOrUndefined(input.cursor),
      limit: Option.getOrUndefined(input.limit),
    }),
    call: (request) => Domains.list(request),
    failure: "Could not list newsletter domains",
    document: true,
  },
).pipe(Command.withDescription("List newsletter domains"));

const addDomain = deriveOverride(
  "add",
  {
    id: idArgument,
    hostname: hostnameArgument,
    idempotencyKey: key,
    dryRun: dryRunFlag,
    json: jsonFlag,
  },
  {
    mapInput: (input) => ({ id: input.id, hostname: input.hostname }),
    call: (request, input) =>
      Domains.add(request, { idempotencyKey: Option.getOrUndefined(input.idempotencyKey) }),
    failure: "Could not add newsletter domain",
    preview: {
      data: (request) => ({ dryRun: true, action: "newsletterDomains.add", request }),
    },
    document: true,
  },
).pipe(Command.withDescription("Add a newsletter domain"));

const getDomain = deriveOverride(
  "get",
  {
    id: idArgument,
    hostname: hostnameArgument,
    json: jsonFlag,
  },
  {
    mapInput: (input) => ({ id: input.id, hostname: input.hostname }),
    call: (request) => Domains.get(request),
    failure: "Could not read newsletter domain",
    document: true,
  },
).pipe(Command.withDescription("Check newsletter domain verification"));

const removeDomain = deriveOverride(
  "remove",
  {
    id: idArgument,
    hostname: hostnameArgument,
    idempotencyKey: key,
    dryRun: dryRunFlag,
    yes: Flag.Boolean("yes").pipe(Flag.withDescription("Confirm removal"), Flag.withDefault(false)),
    json: jsonFlag,
  },
  {
    mapInput: (input) => ({ id: input.id, hostname: input.hostname }),
    call: (request, input) =>
      Domains.remove(request, {
        idempotencyKey: Option.getOrUndefined(input.idempotencyKey),
      }),
    failure: "Could not remove newsletter domain",
    preview: {
      data: (request) => ({ dryRun: true, action: "newsletterDomains.remove", request }),
    },
    confirmation: (request) => ({
      message: `Remove newsletter domain ${request.hostname}?`,
      nonInteractiveMessage: "Pass --yes to remove the domain",
    }),
    document: true,
  },
).pipe(Command.withDescription("Remove a newsletter domain"));

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
