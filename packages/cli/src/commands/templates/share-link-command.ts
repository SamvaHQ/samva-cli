import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TemplateShareLinks from "samva/effect/template-share-links";

import { CliUsageError } from "../../errors";
import { deriveOverride } from "../../lib/derive/curated";
import { jsonFlag, objectRows, printFields } from "../../lib/output";

const projectArgument = Argument.String("project-id").pipe(
  Argument.withDescription("Remote template project to share as a share link"),
);
const slugFlag = Flag.String("slug").pipe(
  Flag.withSchema(Schema.String.check(Schema.isPattern(/^[a-z0-9-]{3,60}$/u))),
  Flag.withDescription("Globally unique link slug: 3–60 lowercase letters, digits, or hyphens"),
);
const dryRunFlag = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Preview the request without contacting the API"),
  Flag.withDefault(false),
);
const renderLink = (value: Readonly<Record<string, unknown>> | null) =>
  value === null ? printFields([["Share link", "Not created"]]) : printFields(objectRows(value));

const create = deriveOverride(
  "create",
  {
    projectId: projectArgument,
    slug: slugFlag.pipe(Flag.optional),
    dryRun: dryRunFlag,
    json: jsonFlag,
  },
  {
    mapInput: ({ projectId, slug }) => ({
      projectId,
      ...Option.match(slug, { onNone: () => ({}), onSome: (value) => ({ slug: value }) }),
    }),
    call: (request) => TemplateShareLinks.create(request),
    failure: "Could not create share link",
    preview: {
      data: (request) => ({ dryRun: true, action: "templates.share-link.create", ...request }),
      render: (request) =>
        printFields(
          objectRows({ dryRun: true, action: "templates.share-link.create", ...request }),
        ),
    },
    render: (value) => renderLink(value),
  },
).pipe(
  Command.withDescription("Export the latest Save as a share link and create its link"),
  Command.withExamples([
    { command: "samva templates share-link create tproj_abc123 --slug for-context-dev --json" },
    { command: "samva templates share-link create tproj_abc123 --dry-run" },
  ]),
);

const update = deriveOverride(
  "update",
  {
    projectId: projectArgument,
    dryRun: dryRunFlag,
    json: jsonFlag,
  },
  {
    mapInput: ({ projectId }) => ({ projectId }),
    call: (request) => TemplateShareLinks.update(request),
    failure: "Could not update share link",
    preview: {
      data: (request) => ({
        dryRun: true,
        action: "templates.share-link.update",
        projectId: request.projectId,
      }),
      render: (request) =>
        printFields(
          objectRows({
            dryRun: true,
            action: "templates.share-link.update",
            projectId: request.projectId,
          }),
        ),
    },
    render: (value) => renderLink(value),
  },
).pipe(
  Command.withDescription("Replace the share link snapshot from the latest Save at the same link"),
  Command.withExamples([{ command: "samva templates share-link update tproj_abc123 --json" }]),
);

const get = deriveOverride(
  "get",
  { projectId: projectArgument, json: jsonFlag },
  {
    mapInput: ({ projectId }) => ({ projectId }),
    call: (request) => TemplateShareLinks.get(request),
    failure: "Could not get share link",
    render: (value) => renderLink(value),
  },
).pipe(
  Command.withDescription("Read the share link, view and open counts, and update time"),
  Command.withExamples([{ command: "samva templates share-link get tproj_abc123 --json" }]),
);

const rename = deriveOverride(
  "rename",
  {
    projectId: projectArgument,
    slug: slugFlag,
    dryRun: dryRunFlag,
    json: jsonFlag,
  },
  {
    mapInput: ({ projectId, slug }) => ({ projectId, slug }),
    call: (request) => TemplateShareLinks.rename(request),
    failure: "Could not rename share link",
    preview: {
      data: (request) => ({
        dryRun: true,
        action: "templates.share-link.rename",
        projectId: request.projectId,
        slug: request.slug,
      }),
      render: (request) =>
        printFields(
          objectRows({
            dryRun: true,
            action: "templates.share-link.rename",
            projectId: request.projectId,
            slug: request.slug,
          }),
        ),
    },
    render: (value) => renderLink(value),
  },
).pipe(
  Command.withDescription("Rename the share link; the previous link stops working"),
  Command.withExamples([
    { command: "samva templates share-link rename tproj_abc123 --slug for-context-dev --dry-run" },
  ]),
);

const deleteCommand = deriveOverride(
  "delete",
  {
    projectId: projectArgument,
    dryRun: dryRunFlag,
    yes: Flag.Boolean("yes").pipe(
      Flag.withDescription("Confirm disabling the share link; existing copies remain"),
      Flag.withDefault(false),
    ),
    json: jsonFlag,
  },
  {
    prepare: ({ projectId, dryRun, yes }) =>
      !dryRun && !yes
        ? Effect.fail(
            new CliUsageError({
              code: "confirmation_required",
              message:
                "share-link delete requires --yes. Preview with samva templates share-link delete <project-id> --dry-run.",
            }),
          )
        : Effect.succeed({ projectId }),
    call: (request) => TemplateShareLinks.delete(request),
    failure: "Could not delete share link",
    preview: {
      data: (request) => ({
        dryRun: true,
        action: "templates.share-link.delete",
        projectId: request.projectId,
      }),
      render: (request) =>
        printFields(
          objectRows({
            dryRun: true,
            action: "templates.share-link.delete",
            projectId: request.projectId,
          }),
        ),
    },
    render: (value) => renderLink(value),
  },
).pipe(
  Command.withDescription("Disable the share link while keeping copies people already opened"),
  Command.withExamples([
    { command: "samva templates share-link delete tproj_abc123 --dry-run" },
    { command: "samva templates share-link delete tproj_abc123 --yes --json" },
  ]),
);

export const shareLinkCommand = Command.make("share-link").pipe(
  Command.withDescription("Share a saved template project through a share link"),
  Command.withExamples([
    { command: "samva templates share-link create tproj_abc123 --slug for-context-dev" },
  ]),
  Command.withSubcommands([create, update, get, rename, deleteCommand]),
);
