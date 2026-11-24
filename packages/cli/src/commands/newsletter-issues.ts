import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Issues from "samva/effect/newsletter-issues";

import { SamvaCliError, toCliApiError } from "../errors";
import { getClientProvider } from "../lib/client";
import { yesFlag } from "../lib/confirm";
import { deriveOverride } from "../lib/derive/curated";
import { jsonFlag, printJsonDocument } from "../lib/output";
import { readStdinUtf8 } from "../lib/stdin";

const idArgument = Argument.String("newsletter-id").pipe(
  Argument.withDescription("Newsletter id (nl_...)"),
);
const pathFlag = Flag.String("path").pipe(
  Flag.withDescription("Markdown issue path, e.g. issues/october.md"),
);
const revisionFlag = Flag.String("revision").pipe(
  Flag.withDescription(
    "Workspace revision inspected before this call; stale revisions are refused",
  ),
);
const keyFlag = Flag.String("idempotency-key").pipe(
  Flag.withDescription("Reuse this key and the same payload for an identical retry"),
);
const dryRunFlag = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Print the request without calling the API"),
  Flag.withDefault(false),
);
const sourceFlag = Flag.String("file").pipe(
  Flag.withDescription("Local UTF-8 Markdown file; use - for piped stdin"),
);
const readContent = (file: string) =>
  file === "-"
    ? readStdinUtf8
    : Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs
          .readFileString(file)
          .pipe(
            Effect.mapError(
              (cause) => new SamvaCliError({ message: `Could not read ${file}: ${String(cause)}` }),
            ),
          );
      });

/** One row per issue: path, draft title, and where its latest send stands. */
const listRows = (result: {
  readonly revision: string | null;
  readonly items: ReadonlyArray<{
    readonly path: string;
    readonly title: string | null;
    readonly latestSend: { readonly run: { readonly status: string } } | null;
  }>;
}) => {
  if (result.items.length === 0) return "No issues yet.";
  const width = Math.max(...result.items.map((item) => item.path.length));
  const rows = result.items.map(
    (item) =>
      `${item.path.padEnd(width)}  ${item.title ?? "(no title)"}  [${item.latestSend?.run.status ?? "draft"}]`,
  );
  return [`Revision ${result.revision ?? "-"}`, ...rows].join("\n");
};

const list = deriveOverride(
  "list",
  { id: idArgument, json: jsonFlag },
  {
    mapInput: (input) => ({ id: input.id }),
    call: (request) => Issues.list(request),
    failure: "Could not list newsletter issues",
    render: (result) => Console.log(listRows(result)),
  },
).pipe(
  Command.withDescription(
    "List issues with each draft's title and its latest send status (draft when never scheduled), plus the current workspace revision",
  ),
  Command.withExamples([{ command: "samva newsletters issues list nl_1234567890abcdef --json" }]),
);

const open = deriveOverride(
  "open",
  { id: idArgument, json: jsonFlag },
  {
    mapInput: (input) => ({ id: input.id }),
    call: (request) => Issues.open(request),
    failure: "Could not open newsletter issues",
    document: true,
  },
).pipe(
  Command.withDescription(
    "Open the existing newsletter issue workspace; does not create a repository",
  ),
  Command.withExamples([{ command: "samva newsletters issues open nl_1234567890abcdef --json" }]),
);

const read = deriveOverride(
  "read",
  {
    id: idArgument,
    json: jsonFlag,
    path: pathFlag,
    revision: revisionFlag,
  },
  {
    mapInput: (input) => ({ id: input.id, path: input.path, expectedRevision: input.revision }),
    call: (request) => Issues.get(request),
    failure: "Could not read newsletter issues",
    document: true,
  },
).pipe(
  Command.withDescription("Read one Markdown issue at the revision you inspected"),
  Command.withExamples([
    {
      command:
        "samva newsletters issues read nl_1234567890abcdef --path issues/october.md --revision 4 --json",
    },
  ]),
);

const create = Command.make("create", {
  id: idArgument,
  json: jsonFlag,
  path: pathFlag,
  revision: revisionFlag.pipe(Flag.optional),
  file: sourceFlag,
  idempotencyKey: keyFlag,
  dryRun: dryRunFlag,
}).pipe(
  Command.withDescription(
    "Create an unsaved issue; omit --revision only for the first issue or its retry",
  ),
  Command.withExamples([
    {
      command:
        "samva newsletters issues create nl_1234567890abcdef --path issues/october.md --file ./october.md --idempotency-key edit-1 --json",
    },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, path, revision, file, idempotencyKey, dryRun, json }) {
      const content = yield* readContent(file);
      const request = { id, path, expectedRevision: Option.getOrUndefined(revision), content };
      if (dryRun)
        return yield* printJsonDocument({ dryRun, action: "newsletterIssues.create", request });
      const client = yield* getClientProvider;
      const result = yield* Issues.create(request, { idempotencyKey }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not create newsletter issues", error)),
      );
      yield* printJsonDocument(result);
    }),
  ),
);

const update = Command.make("update", {
  id: idArgument,
  json: jsonFlag,
  path: pathFlag,
  revision: revisionFlag,
  file: sourceFlag,
  idempotencyKey: keyFlag,
  dryRun: dryRunFlag,
}).pipe(
  Command.withDescription("Replace a complete Markdown issue under a revision fence"),
  Command.withExamples([
    {
      command:
        "samva newsletters issues update nl_1234567890abcdef --path issues/october.md --revision 4 --file ./october.md --idempotency-key edit-1 --json",
    },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, path, revision, file, idempotencyKey, dryRun, json }) {
      const content = yield* readContent(file);
      const request = { id, path, expectedRevision: revision, content };
      if (dryRun)
        return yield* printJsonDocument({ dryRun, action: "newsletterIssues.update", request });
      const client = yield* getClientProvider;
      const result = yield* Issues.update(request, { idempotencyKey }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not update newsletter issues", error)),
      );
      yield* printJsonDocument(result);
    }),
  ),
);

const remove = deriveOverride(
  "delete",
  {
    id: idArgument,
    json: jsonFlag,
    path: pathFlag,
    revision: revisionFlag,
    idempotencyKey: keyFlag,
    dryRun: dryRunFlag,
    yes: yesFlag("Confirm removal"),
  },
  {
    mapInput: (input) => ({ id: input.id, path: input.path, expectedRevision: input.revision }),
    call: (request, input) => Issues.remove(request, { idempotencyKey: input.idempotencyKey }),
    failure: "Could not delete newsletter issues",
    preview: {
      data: (request) => ({ dryRun: true, action: "newsletterIssues.remove", request }),
    },
    confirmation: (request) => ({
      message: `Delete ${request.path} from topic ${request.id}'s draft?`,
      nonInteractiveMessage:
        "Issue deletion requires --yes outside a terminal. Preview with --dry-run.",
    }),
    document: true,
  },
).pipe(
  Command.withDescription("Delete an issue from the draft; the default issue must remain"),
  Command.withExamples([
    {
      command:
        "samva newsletters issues delete nl_1234567890abcdef --path issues/october.md --revision 4 --idempotency-key edit-1 --yes --json",
    },
  ]),
);

const save = deriveOverride(
  "save",
  {
    id: idArgument,
    json: jsonFlag,
    revision: revisionFlag,
    idempotencyKey: keyFlag,
    dryRun: dryRunFlag,
    head: Flag.String("head").pipe(
      Flag.withDescription("Expected branch-head commit from issues head"),
    ),
    message: Flag.String("message").pipe(Flag.withDescription("Git commit message")),
  },
  {
    mapInput: (input) => ({
      id: input.id,
      expectedRevision: input.revision,
      expectedHead: input.head,
      message: input.message,
    }),
    call: (request, input) => Issues.save(request, { idempotencyKey: input.idempotencyKey }),
    failure: "Could not save newsletter issues",
    preview: {
      data: (request) => ({ dryRun: true, action: "newsletterIssues.save", request }),
    },
    document: true,
  },
).pipe(
  Command.withDescription("Validate and save the issue project as a Git commit"),
  Command.withExamples([
    {
      command:
        'samva newsletters issues save nl_1234567890abcdef --revision 4 --idempotency-key edit-1 --head 0000000000000000000000000000000000000000 --message "Save October issue" --json',
    },
  ]),
);

const check = deriveOverride(
  "check",
  {
    id: idArgument,
    json: jsonFlag,
    path: pathFlag,
    revision: revisionFlag,
  },
  {
    mapInput: (input) => ({ id: input.id, path: input.path, expectedRevision: input.revision }),
    call: (request) => Issues.check(request),
    failure: "Could not check newsletter issues",
    document: true,
  },
).pipe(
  Command.withDescription("Compile one issue and report its diagnostics and declared fixtures"),
  Command.withExamples([
    {
      command:
        "samva newsletters issues check nl_1234567890abcdef --path issues/october.md --revision 4 --json",
    },
  ]),
);

const render = deriveOverride(
  "render",
  {
    id: idArgument,
    json: jsonFlag,
    path: pathFlag,
    revision: revisionFlag,
    fixture: Flag.String("fixture").pipe(
      Flag.withDescription("Fixture declared by the issue layout"),
    ),
    target: Flag.Literals("target", ["email", "web"]).pipe(Flag.withDescription("Render target")),
  },
  {
    mapInput: (input) => ({
      id: input.id,
      path: input.path,
      expectedRevision: input.revision,
      fixture: input.fixture,
      target: input.target,
    }),
    call: (request) => Issues.render(request),
    failure: "Could not render newsletter issues",
    document: true,
  },
).pipe(
  Command.withDescription("Render an issue fixture to the email or web target"),
  Command.withExamples([
    {
      command:
        "samva newsletters issues render nl_1234567890abcdef --path issues/october.md --revision 4 --fixture default --target email --json",
    },
  ]),
);

const head = deriveOverride(
  "head",
  { id: idArgument, json: jsonFlag },
  {
    mapInput: (input) => ({ id: input.id }),
    call: (request) => Issues.head(request),
    failure: "Could not head newsletter issues",
    document: true,
  },
).pipe(
  Command.withDescription("Read the current workspace revision and repository branch head"),
  Command.withExamples([{ command: "samva newsletters issues head nl_1234567890abcdef --json" }]),
);

const history = deriveOverride(
  "history",
  {
    id: idArgument,
    json: jsonFlag,
    limit: Flag.Int("limit").pipe(
      Flag.withDescription("Commits to return (1–100; default 20)"),
      Flag.withDefault(20),
    ),
  },
  {
    mapInput: (input) => ({ id: input.id, limit: input.limit }),
    call: (request) => Issues.history(request),
    failure: "Could not history newsletter issues",
    document: true,
  },
).pipe(
  Command.withDescription("List a bounded set of saved commits, newest first"),
  Command.withExamples([
    { command: "samva newsletters issues history nl_1234567890abcdef --json" },
  ]),
);

export const issuesCommand = Command.make("issues").pipe(
  Command.withDescription(
    "Author topic-owned Markdown issues; results are JSON receipts for the next call",
  ),
  Command.withExamples([{ command: "samva newsletters issues list nl_1234567890abcdef --json" }]),
  Command.withSubcommands([
    list,
    open,
    read,
    create,
    update,
    remove,
    save,
    check,
    render,
    head,
    history,
  ]),
);
