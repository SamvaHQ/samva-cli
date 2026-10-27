import { basename, resolve } from "node:path";

import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Templates from "samva/effect/templates";

import { CliUsageError, SamvaCliError, toCliApiError } from "../../errors";
import { getClientProvider } from "../../lib/client";
import { jsonFlag, printJsonDocument } from "../../lib/output";

/**
 * `samva templates workspace …` — the hosted project workspace over the CLI.
 *
 * The Git commands remain the way to author a project you have cloned. This
 * group is for a caller that has no clone: an agent in a sandbox, a CI job, a
 * script. It reaches exactly the operations the hosted MCP tools reach, through
 * the same domain-authorized API, so both external transports complete the same
 * journey against the same substrate rather than two lookalike ones.
 *
 * Every command prints its complete result as JSON. There is no human rendering
 * here on purpose: these outputs are revisions, digests, and diagnostics that a
 * caller feeds back into the next call.
 */

const templateIdArgument = Argument.String("template-id").pipe(
  Argument.withDescription("Template whose project workspace to act on"),
);

const revisionFlag = Flag.String("revision").pipe(
  Flag.withDescription(
    "Workspace revision this call is fenced to; a workspace that moved refuses the call",
  ),
);

/** A read-only call's fence: the revision it names, else the revision the workspace is at now. */
const readRevisionFlag = Flag.String("revision").pipe(
  Flag.withDescription(
    "Workspace revision this call is fenced to; a workspace that moved refuses the call (default: the workspace's current revision)",
  ),
  Flag.optional,
);

const currentRevision = (id: string, revision: Option.Option<string>) =>
  Option.isSome(revision)
    ? Effect.succeed(revision.value)
    : Effect.gen(function* () {
        const client = yield* getClientProvider;
        const view = yield* Templates.openWorkspace({ id }).pipe(
          client.provide,
          Effect.mapError((error) => {
            const failure = toCliApiError("Could not read the template workspace revision", error);
            return new SamvaCliError({
              message: `${failure.message} The current revision is read by opening the workspace, which needs templates:create; pass --revision to skip that.`,
              api: failure.api,
              details: failure.details,
            });
          }),
        );
        return view.workspace.revision;
      });

const idempotencyKeyFlag = Flag.String("idempotency-key").pipe(
  Flag.withDescription(
    "Key so an identical retry returns the original result rather than repeating it",
  ),
);

const apiFailure = (what: string) => (error: unknown) => toCliApiError(`Could not ${what}`, error);

/** Machine-only output: these results are inputs to the caller's next call. */
const emit = (value: unknown) => printJsonDocument(value);

const open = Command.make("open", { id: templateIdArgument, json: jsonFlag }).pipe(
  Command.withDescription("Open the project workspace and read its revision, files, and conflicts"),
  Command.withExamples([
    {
      command: "samva templates workspace open tmpl_abc123",
      description: "Start here: every other command is fenced to the revision this returns",
    },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, json }) {
      const client = yield* getClientProvider;
      const view = yield* Templates.openWorkspace({ id }).pipe(
        client.provide,
        Effect.mapError(apiFailure("open the template workspace")),
      );
      yield* emit(view);
    }),
  ),
);

const diff = Command.make("diff", {
  id: templateIdArgument,
  revision: readRevisionFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show every unsaved change against the workspace Git base"),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, revision, json }) {
      const expectedRevision = yield* currentRevision(id, revision);
      const client = yield* getClientProvider;
      const result = yield* Templates.diffWorkspace({ id, expectedRevision }).pipe(
        client.provide,
        Effect.mapError(apiFailure("diff the template workspace")),
      );
      yield* emit(result);
    }),
  ),
);

const patch = Command.make("patch", {
  id: templateIdArgument,
  revision: revisionFlag,
  set: Flag.String("set").pipe(
    Flag.withDescription(
      "Replace a project file with a local file's contents, as <project-path>=<local-file>",
    ),
    Flag.atLeast(0),
  ),
  remove: Flag.String("delete").pipe(
    Flag.withDescription("Delete a project file"),
    Flag.atLeast(0),
  ),
  idempotencyKey: idempotencyKeyFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Apply file replacements and deletions to the shared workspace"),
  Command.withExamples([
    {
      command:
        "samva templates workspace patch tmpl_abc123 --revision 4 --set templates/welcome.tsx=./welcome.tsx --idempotency-key edit-1",
      description: "Write one file, fenced to the revision you inspected",
    },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, revision, set, remove, idempotencyKey, json }) {
      if (set.length === 0 && remove.length === 0)
        return yield* new CliUsageError({
          code: "empty_patch",
          message:
            "Provide at least one --set <project-path>=<local-file> or --delete <project-path>.",
        });
      const fs = yield* FileSystem.FileSystem;
      const written: { path: string; content: string | null }[] = [];
      for (const entry of set) {
        const separator = entry.indexOf("=");
        if (separator <= 0)
          return yield* new CliUsageError({
            code: "malformed_set",
            message: `--set must be <project-path>=<local-file>; got ${entry}.`,
          });
        const path = entry.slice(0, separator);
        const source = resolve(entry.slice(separator + 1));
        const content = yield* fs
          .readFileString(source)
          .pipe(
            Effect.mapError(
              (cause) =>
                new SamvaCliError({ message: `Could not read ${source}: ${String(cause)}` }),
            ),
          );
        written.push({ path, content });
      }
      for (const path of remove) written.push({ path, content: null });
      const client = yield* getClientProvider;
      const view = yield* Templates.patchWorkspace({
        id,
        expectedRevision: revision,
        patches: written,
        idempotencyKey,
      }).pipe(client.provide, Effect.mapError(apiFailure("patch the template workspace")));
      yield* emit(view);
    }),
  ),
);

const addAsset = Command.make("add-asset", {
  id: templateIdArgument,
  file: Argument.String("file").pipe(
    Argument.withDescription("Local image or font: .png, .jpg, .jpeg, .gif, .webp, or .woff2"),
  ),
  revision: revisionFlag,
  path: Flag.String("path").pipe(
    Flag.withDescription("Project path to write; defaults to assets/<file name>"),
    Flag.optional,
  ),
  replace: Flag.Boolean("replace").pipe(
    Flag.withDescription("Change a file that already exists; without it, an existing path refuses"),
    Flag.withDefault(false),
  ),
  idempotencyKey: idempotencyKeyFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Write one image or font (at most 1 MiB) into the workspace as an unsaved file",
  ),
  Command.withExamples([
    {
      command:
        "samva templates workspace add-asset tmpl_abc123 ./logo.png --revision 4 --idempotency-key logo-1",
      description: "Add assets/logo.png; import it from the template, then save to commit it",
    },
    {
      command:
        "samva templates workspace add-asset tmpl_abc123 ./logo@2x.png --path assets/logo.png --replace --revision 5 --idempotency-key logo-2",
      description: "Change an existing asset in place",
    },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, file, revision, path, replace, idempotencyKey, json }) {
      const fs = yield* FileSystem.FileSystem;
      const source = resolve(file);
      const bytes = yield* fs
        .readFile(source)
        .pipe(
          Effect.mapError(
            (cause) => new SamvaCliError({ message: `Could not read ${source}: ${String(cause)}` }),
          ),
        );
      const client = yield* getClientProvider;
      const view = yield* Templates.putWorkspaceAsset({
        id,
        expectedRevision: revision,
        path: Option.getOrElse(path, () => `assets/${basename(source)}`),
        contentBase64: Buffer.from(bytes).toString("base64"),
        replace,
        idempotencyKey,
      }).pipe(client.provide, Effect.mapError(apiFailure("add the template asset")));
      yield* emit(view);
    }),
  ),
);

const check = Command.make("check", {
  id: templateIdArgument,
  revision: readRevisionFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Build the effective workspace tree and report what it declares plus every finding",
  ),
  Command.withExamples([
    {
      command: "samva templates workspace check tmpl_abc123",
      description:
        "Read the template id, input schema, fixture names, and located diagnostics without rendering or writing; --revision 5 fences the call to a revision you inspected",
    },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, revision, json }) {
      const expectedRevision = yield* currentRevision(id, revision);
      const client = yield* getClientProvider;
      const result = yield* Templates.checkWorkspace({ id, expectedRevision }).pipe(
        client.provide,
        Effect.mapError(apiFailure("check the template workspace")),
      );
      yield* emit(result);
    }),
  ),
);

const fixture = Command.make("fixture", {
  id: templateIdArgument,
  revision: readRevisionFlag,
  name: Flag.String("name").pipe(
    Flag.withDescription("One of the fixture names `workspace check` reported"),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Render one input the template declares, as the recipient receives it"),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, revision, name, json }) {
      const expectedRevision = yield* currentRevision(id, revision);
      const client = yield* getClientProvider;
      const result = yield* Templates.renderWorkspaceFixture({
        id,
        expectedRevision,
        fixture: name,
      }).pipe(client.provide, Effect.mapError(apiFailure("render the template fixture")));
      yield* emit(result);
    }),
  ),
);

const save = Command.make("save", {
  id: templateIdArgument,
  revision: revisionFlag,
  head: Flag.String("head").pipe(
    Flag.withDescription(
      "Commit the workspace expects to be the branch head, from `workspace open`",
    ),
  ),
  message: Flag.String("message").pipe(Flag.withDescription("Commit message")),
  idempotencyKey: idempotencyKeyFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Validate the effective tree and append one ordinary Git commit"),
  Command.withExamples([
    {
      command:
        'samva templates workspace save tmpl_abc123 --revision 5 --head 0a1b… --message "Update welcome" --idempotency-key save-1',
      description: "Commit the workspace; the receipt names the commit to publish",
    },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, revision, head, message, idempotencyKey, json }) {
      const client = yield* getClientProvider;
      const receipt = yield* Templates.saveWorkspace({
        id,
        expectedRevision: revision,
        expectedHead: head,
        message,
        idempotencyKey,
      }).pipe(client.provide, Effect.mapError(apiFailure("save the template workspace")));
      yield* emit(receipt);
    }),
  ),
);

const history = Command.make("history", {
  id: templateIdArgument,
  limit: Flag.Int("limit").pipe(
    Flag.withDescription("Commits to return, newest first"),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List saved commits and identify the published one"),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, limit, json }) {
      const client = yield* getClientProvider;
      const limitValue = Option.getOrUndefined(limit);
      const result = yield* Templates.workspaceHistory({
        id,
        ...(limitValue === undefined ? {} : { limit: limitValue }),
      }).pipe(client.provide, Effect.mapError(apiFailure("list the template workspace history")));
      yield* emit(result);
    }),
  ),
);

const publish = Command.make("publish", {
  id: templateIdArgument,
  revision: revisionFlag,
  commit: Flag.String("commit").pipe(
    Flag.withDescription("Saved commit to publish, from a `workspace save` receipt"),
  ),
  entry: Flag.String("entry").pipe(
    Flag.withDescription("TSX entry path to publish, from `templates get`"),
  ),
  projectId: Flag.String("project-id").pipe(
    Flag.withDescription("Project the commit belongs to, from `workspace open`"),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Publish an exact saved commit without a local clone"),
  Command.withExamples([
    {
      command:
        "samva templates workspace publish tmpl_abc123 --revision 6 --commit 0a1b… --entry templates/welcome.tsx --project-id tproj_abc123",
      description:
        "Complete the workspace journey; `templates publish` is the Git-clone equivalent",
    },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, revision, commit, entry, projectId, json }) {
      const client = yield* getClientProvider;
      const publication = yield* Templates.publish({
        id,
        projectId,
        commitSha: commit,
        entryPath: entry,
        expectedWorkspaceRevision: revision,
      }).pipe(client.provide, Effect.mapError(apiFailure("publish the template commit")));
      yield* emit(publication);
    }),
  ),
);

export const workspaceCommand = Command.make("workspace").pipe(
  Command.withDescription(
    "Author a template project through the hosted workspace, without a clone",
  ),
  Command.withExamples([
    {
      command: "samva templates workspace open tmpl_abc123",
      description: "Read the revision every other workspace command is fenced to",
    },
    {
      command: "samva templates workspace check tmpl_abc123 --revision 5",
      description: "Read what the template declares and every finding, without writing",
    },
  ]),
  Command.withSubcommands([open, diff, patch, addAsset, check, fixture, save, history, publish]),
);
