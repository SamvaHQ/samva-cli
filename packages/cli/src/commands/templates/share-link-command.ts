import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as TemplateShareLinks from "samva/effect/template-share-links";

import { CliUsageError, toCliApiError } from "../../errors";
import { getClientProvider } from "../../lib/client";
import { jsonFlag, objectRows, printFields, printJson } from "../../lib/output";

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
const render = (value: Readonly<Record<string, unknown>> | null, json: boolean) =>
  json
    ? printJson(value)
    : value === null
      ? printFields([["Share link", "Not created"]])
      : printFields(objectRows(value));

const create = Command.make("create", {
  projectId: projectArgument,
  slug: slugFlag.pipe(Flag.optional),
  dryRun: dryRunFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Export the latest Save as a share link and create its link"),
  Command.withExamples([
    { command: "samva templates share-link create tproj_abc123 --slug for-context-dev --json" },
    { command: "samva templates share-link create tproj_abc123 --dry-run" },
  ]),
  Command.withHandler(({ projectId, slug, dryRun, json }) =>
    Effect.gen(function* () {
      const request = {
        projectId,
        ...Option.match(slug, { onNone: () => ({}), onSome: (value) => ({ slug: value }) }),
      };
      if (dryRun)
        return yield* render(
          { dryRun: true, action: "templates.share-link.create", ...request },
          json,
        );
      const client = yield* getClientProvider;
      const result = yield* TemplateShareLinks.create(request).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not create share link", error)),
      );
      yield* render(result, json);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const update = Command.make("update", {
  projectId: projectArgument,
  dryRun: dryRunFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Replace the share link snapshot from the latest Save at the same link"),
  Command.withExamples([{ command: "samva templates share-link update tproj_abc123 --json" }]),
  Command.withHandler(({ projectId, dryRun, json }) =>
    Effect.gen(function* () {
      if (dryRun)
        return yield* render(
          { dryRun: true, action: "templates.share-link.update", projectId },
          json,
        );
      const client = yield* getClientProvider;
      const result = yield* TemplateShareLinks.update({ projectId }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not update share link", error)),
      );
      yield* render(result, json);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const get = Command.make("get", { projectId: projectArgument, json: jsonFlag }).pipe(
  Command.withDescription("Read the share link, view and open counts, and update time"),
  Command.withExamples([{ command: "samva templates share-link get tproj_abc123 --json" }]),
  Command.withHandler(({ projectId, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const result = yield* TemplateShareLinks.get({ projectId }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not get share link", error)),
      );
      yield* render(result, json);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const rename = Command.make("rename", {
  projectId: projectArgument,
  slug: slugFlag,
  dryRun: dryRunFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Rename the share link; the previous link stops working"),
  Command.withExamples([
    { command: "samva templates share-link rename tproj_abc123 --slug for-context-dev --dry-run" },
  ]),
  Command.withHandler(({ projectId, slug, dryRun, json }) =>
    Effect.gen(function* () {
      if (dryRun)
        return yield* render(
          { dryRun: true, action: "templates.share-link.rename", projectId, slug },
          json,
        );
      const client = yield* getClientProvider;
      const result = yield* TemplateShareLinks.rename({ projectId, slug }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not rename share link", error)),
      );
      yield* render(result, json);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const deleteCommand = Command.make("delete", {
  projectId: projectArgument,
  dryRun: dryRunFlag,
  yes: Flag.Boolean("yes").pipe(
    Flag.withDescription("Confirm disabling the share link; existing copies remain"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Disable the share link while keeping copies people already opened"),
  Command.withExamples([
    { command: "samva templates share-link delete tproj_abc123 --dry-run" },
    { command: "samva templates share-link delete tproj_abc123 --yes --json" },
  ]),
  Command.withHandler(({ projectId, dryRun, yes, json }) =>
    Effect.gen(function* () {
      if (dryRun)
        return yield* render(
          { dryRun: true, action: "templates.share-link.delete", projectId },
          json,
        );
      if (!yes)
        return yield* new CliUsageError({
          code: "confirmation_required",
          message:
            "share-link delete requires --yes. Preview with samva templates share-link delete <project-id> --dry-run.",
        });
      const client = yield* getClientProvider;
      const result = yield* TemplateShareLinks.delete({ projectId }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not delete share link", error)),
      );
      yield* render(result, json);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

export const shareLinkCommand = Command.make("share-link").pipe(
  Command.withDescription("Share a saved template project through a share link"),
  Command.withExamples([
    { command: "samva templates share-link create tproj_abc123 --slug for-context-dev" },
  ]),
  Command.withSubcommands([create, update, get, rename, deleteCommand]),
);
