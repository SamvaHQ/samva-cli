import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Issues from "samva/effect/newsletter-issues";

import { SamvaCliError, toCliApiError } from "../errors";
import { getClientProvider } from "../lib/client";
import { confirmDestructive } from "../lib/confirm";
import { jsonFlag, printJsonDocument, printResult } from "../lib/output";
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

const list = Command.make("list", { id: idArgument, json: jsonFlag }).pipe(
  Command.withDescription(
    "List issues with each draft's title and its latest send status (draft when never scheduled), plus the current workspace revision",
  ),
  Command.withExamples([{ command: "samva newsletters issues list nl_1234567890abcdef --json" }]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, json }) {
      const request = { id };
      const client = yield* getClientProvider;
      const result = yield* Issues.list(request).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not list newsletter issues", error)),
      );
      yield* printResult(result, listRows(result));
    }),
  ),
);

const open = Command.make("open", { id: idArgument, json: jsonFlag }).pipe(
  Command.withDescription(
    "Open the existing newsletter issue workspace; does not create a repository",
  ),
  Command.withExamples([{ command: "samva newsletters issues open nl_1234567890abcdef --json" }]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, json }) {
      const request = { id };
      const client = yield* getClientProvider;
      const result = yield* Issues.open(request).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not open newsletter issues", error)),
      );
      yield* printJsonDocument(result);
    }),
  ),
);

const read = Command.make("read", {
  id: idArgument,
  json: jsonFlag,
  path: pathFlag,
  revision: revisionFlag,
}).pipe(
  Command.withDescription("Read one Markdown issue at the revision you inspected"),
  Command.withExamples([
    {
      command:
        "samva newsletters issues read nl_1234567890abcdef --path issues/october.md --revision 4 --json",
    },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, path, revision, json }) {
      const request = { id, path, expectedRevision: revision };
      const client = yield* getClientProvider;
      const result = yield* Issues.get(request).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not read newsletter issues", error)),
      );
      yield* printJsonDocument(result);
    }),
  ),
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

const remove = Command.make("delete", {
  id: idArgument,
  json: jsonFlag,
  path: pathFlag,
  revision: revisionFlag,
  idempotencyKey: keyFlag,
  dryRun: dryRunFlag,
  yes: Flag.Boolean("yes").pipe(
    Flag.withDescription("Confirm removal without prompting"),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Delete an issue from the draft; the default issue must remain"),
  Command.withExamples([
    {
      command:
        "samva newsletters issues delete nl_1234567890abcdef --path issues/october.md --revision 4 --idempotency-key edit-1 --yes --json",
    },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, path, revision, idempotencyKey, dryRun, yes, json }) {
      const request = { id, path, expectedRevision: revision };
      if (dryRun)
        return yield* printJsonDocument({ dryRun, action: "newsletterIssues.remove", request });
      yield* confirmDestructive({
        yes,
        json,
        message: `Delete ${path} from topic ${id}'s draft?`,
        nonInteractiveMessage:
          "Issue deletion requires --yes outside a terminal. Preview with --dry-run.",
      });
      const client = yield* getClientProvider;
      const result = yield* Issues.remove(request, { idempotencyKey }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not delete newsletter issues", error)),
      );
      yield* printJsonDocument(result);
    }),
  ),
);

const save = Command.make("save", {
  id: idArgument,
  json: jsonFlag,
  revision: revisionFlag,
  idempotencyKey: keyFlag,
  dryRun: dryRunFlag,
  head: Flag.String("head").pipe(
    Flag.withDescription("Expected branch-head commit from issues head"),
  ),
  message: Flag.String("message").pipe(Flag.withDescription("Git commit message")),
}).pipe(
  Command.withDescription("Validate and save the issue project as a Git commit"),
  Command.withExamples([
    {
      command:
        'samva newsletters issues save nl_1234567890abcdef --revision 4 --idempotency-key edit-1 --head 0000000000000000000000000000000000000000 --message "Save October issue" --json',
    },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, revision, idempotencyKey, dryRun, head, message, json }) {
      const request = { id, expectedRevision: revision, expectedHead: head, message };
      if (dryRun)
        return yield* printJsonDocument({ dryRun, action: "newsletterIssues.save", request });
      const client = yield* getClientProvider;
      const result = yield* Issues.save(request, { idempotencyKey }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not save newsletter issues", error)),
      );
      yield* printJsonDocument(result);
    }),
  ),
);

const check = Command.make("check", {
  id: idArgument,
  json: jsonFlag,
  path: pathFlag,
  revision: revisionFlag,
}).pipe(
  Command.withDescription("Compile one issue and report its diagnostics and declared fixtures"),
  Command.withExamples([
    {
      command:
        "samva newsletters issues check nl_1234567890abcdef --path issues/october.md --revision 4 --json",
    },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, path, revision, json }) {
      const request = { id, path, expectedRevision: revision };
      const client = yield* getClientProvider;
      const result = yield* Issues.check(request).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not check newsletter issues", error)),
      );
      yield* printJsonDocument(result);
    }),
  ),
);

const render = Command.make("render", {
  id: idArgument,
  json: jsonFlag,
  path: pathFlag,
  revision: revisionFlag,
  fixture: Flag.String("fixture").pipe(
    Flag.withDescription("Fixture declared by the issue layout"),
  ),
  target: Flag.Literals("target", ["email", "web"]).pipe(Flag.withDescription("Render target")),
}).pipe(
  Command.withDescription("Render an issue fixture to the email or web target"),
  Command.withExamples([
    {
      command:
        "samva newsletters issues render nl_1234567890abcdef --path issues/october.md --revision 4 --fixture default --target email --json",
    },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, path, revision, fixture, target, json }) {
      const request = { id, path, expectedRevision: revision, fixture, target };
      const client = yield* getClientProvider;
      const result = yield* Issues.render(request).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not render newsletter issues", error)),
      );
      yield* printJsonDocument(result);
    }),
  ),
);

const head = Command.make("head", { id: idArgument, json: jsonFlag }).pipe(
  Command.withDescription("Read the current workspace revision and repository branch head"),
  Command.withExamples([{ command: "samva newsletters issues head nl_1234567890abcdef --json" }]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, json }) {
      const request = { id };
      const client = yield* getClientProvider;
      const result = yield* Issues.head(request).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not head newsletter issues", error)),
      );
      yield* printJsonDocument(result);
    }),
  ),
);

const history = Command.make("history", {
  id: idArgument,
  json: jsonFlag,
  limit: Flag.Int("limit").pipe(
    Flag.withDescription("Commits to return (1–100; default 20)"),
    Flag.withDefault(20),
  ),
}).pipe(
  Command.withDescription("List a bounded set of saved commits, newest first"),
  Command.withExamples([
    { command: "samva newsletters issues history nl_1234567890abcdef --json" },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, limit, json }) {
      const request = { id, limit };
      const client = yield* getClientProvider;
      const result = yield* Issues.history(request).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not history newsletter issues", error)),
      );
      yield* printJsonDocument(result);
    }),
  ),
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
