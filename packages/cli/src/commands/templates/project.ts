import { resolve } from "node:path";

import { declaredTemplateId } from "@samva/core/templates/declared-id";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Templates from "samva/effect/templates";

import { resolveExecutionSelection } from "../../config/store";
import {
  CliResultError,
  CliUsageError,
  formatApiError,
  SamvaCliError,
  toCliApiError,
} from "../../errors";
import { getAuthenticatedJson, getClientProvider } from "../../lib/client";
import { jsonFlag, printFields, printJson } from "../../lib/output";
import { readStdinUtf8 } from "../../lib/stdin";
import { buildDir } from "./local-build";

const templateId = Argument.String("id").pipe(Argument.withDescription("Template id"));

const projectOrTemplateId = Argument.String("id").pipe(
  Argument.withDescription("Template project id (tproj_...) or the id of any template in it"),
);

export const runGit = (
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string | undefined } = {},
) =>
  Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn(["git", ...args], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exitCode !== 0) {
        return Promise.reject(
          new SamvaCliError({ message: stderr.trim() || `git ${args[0]} failed` }),
        );
      }
      return stdout.trim();
    },
    catch: (cause) =>
      cause instanceof SamvaCliError
        ? cause
        : new SamvaCliError({
            message: `Git operation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
  });

const shellWord = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

export const credentialHelperCommand = (cliArgs: ReadonlyArray<string>): string => {
  // Git appends `get`, `store`, or `erase` to a `!` helper's shell command.
  // End with a function invocation so that operation becomes `$1` instead of
  // invalid syntax after the final `fi`.
  const operation = '"$1"';
  const direct = [...["samva", ...cliArgs].map(shellWord), operation].join(" ");
  // Let Bun resolve the selector from its shared cache, installing it when a
  // later Git operation outlives the CLI installation that configured the repo.
  // Keep installation chatter off stdout: Git expects only credential fields.
  const packageFallback = ["bunx", "--bun", "--silent", "@samva/cli", ...cliArgs]
    .map(shellWord)
    .concat(operation)
    .join(" ");
  return `!samva_credential() { if command -v samva >/dev/null 2>&1; then exec ${direct}; else exec ${packageFallback}; fi; }; samva_credential`;
};

const helperCommand = Effect.fn("Templates.helperCommand")(function* (
  id: string,
  scope: "read" | "write",
) {
  const selection = yield* resolveExecutionSelection;
  const cliArgs = [
    "--profile",
    selection.profile,
    "--api-url",
    selection.apiUrl,
    ...(selection.apiKey === undefined && selection.orgSlug !== undefined
      ? ["--org", selection.orgSlug]
      : []),
    "templates",
    "credential",
    id,
    "--scope",
    scope,
  ];
  return credentialHelperCommand(cliArgs);
});

// A clone records only its project. Each entry's template is resolved from the project's
// catalog by path, so one clone publishes every email in the project.
const configureClone = Effect.fn("Templates.configureClone")(function* (input: {
  readonly root: string;
  readonly templateId: string;
  readonly projectId: string;
}) {
  const helper = yield* helperCommand(input.templateId, "write");
  yield* runGit(["config", "--local", "credential.useHttpPath", "true"], { cwd: input.root });
  yield* runGit(["config", "--local", "credential.helper", ""], { cwd: input.root });
  yield* runGit(["config", "--local", "--add", "credential.helper", helper], {
    cwd: input.root,
  });
  yield* runGit(["config", "--local", "samva.projectId", input.projectId], { cwd: input.root });
});

type TemplateRecord = Effect.Success<ReturnType<typeof Templates.list>>["items"][number];

const PROJECT_PAGE_SIZE = 100;

/** Every template registered in one project, active or not, ordered by entry path. */
export const listProjectTemplates = Effect.fn("Templates.listProjectTemplates")(function* (
  projectId: string,
) {
  const client = yield* getClientProvider;
  const templates: TemplateRecord[] = [];
  let cursor: string | undefined;
  for (;;) {
    const data = yield* Templates.list({
      projectId,
      cursor,
      limit: PROJECT_PAGE_SIZE,
    }).pipe(
      client.provide,
      Effect.mapError((error) => toCliApiError("Could not read the template project", error)),
    );
    templates.push(...data.items);
    if (data.nextCursor === null) break;
    cursor = data.nextCursor;
  }
  if (templates.length === 0) {
    return yield* new SamvaCliError({
      message: `Template project ${projectId} was not found or has no templates.`,
    });
  }
  return templates.sort((left, right) => left.entryPath.localeCompare(right.entryPath));
});

const cloneProject = Effect.fn("Templates.cloneProject")(function* (input: {
  readonly id: string;
  readonly dir: string;
}) {
  const client = yield* getClientProvider;
  // A project id clones through any of its templates: the repository is the project's.
  const cloneTemplateId = input.id.startsWith("tproj_")
    ? (yield* listProjectTemplates(input.id))[0]!.id
    : input.id;
  const [template, repository] = yield* Effect.all(
    [
      Templates.getById({ id: cloneTemplateId }).pipe(client.provide),
      Templates.getGitRepository({ id: cloneTemplateId }).pipe(client.provide),
    ],
    { concurrency: 2 },
  ).pipe(Effect.mapError((error) => toCliApiError("Could not resolve template project", error)));
  const root = resolve(input.dir);
  const helper = yield* helperCommand(template.id, "read");
  yield* runGit([
    "-c",
    "credential.helper=",
    "-c",
    `credential.helper=${helper}`,
    "-c",
    "credential.useHttpPath=true",
    "clone",
    "--branch",
    repository.defaultBranch,
    "--origin",
    "origin",
    "--",
    repository.remote,
    root,
  ]);
  yield* configureClone({
    root,
    templateId: template.id,
    projectId: template.projectId,
  });
  const commit = yield* runGit(["rev-parse", "HEAD"], { cwd: root });
  return {
    action: "templates.clone" as const,
    templateId: template.id,
    projectId: template.projectId,
    entryPath: template.entryPath,
    dir: root,
    remote: repository.remote,
    branch: repository.defaultBranch,
    commit,
  };
});

export const clone = Command.make("clone", {
  id: projectOrTemplateId,
  dir: Flag.Directory("dir").pipe(Flag.withDescription("Destination directory"), Flag.optional),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Clone a template project with ordinary Git"),
  Command.withExamples([
    {
      command: "samva templates clone tproj_abc123 --dir account-email",
      description: "Clone a project and configure its repo-local Samva credential helper",
    },
    {
      command: "samva templates clone tmpl_abc123",
      description: "Clone the project a template belongs to",
    },
  ]),
  Command.withHandler(({ id, dir, json }) =>
    Effect.gen(function* () {
      const result = yield* cloneProject({ id, dir: Option.getOrElse(dir, () => ".") });
      if (json) return yield* printJson(result);
      yield* printFields([
        ["Template", result.templateId],
        ["Project", result.projectId],
        ["Directory", result.dir],
        ["Branch", result.branch],
        ["Commit", result.commit],
      ]);
      yield* Effect.logInfo(`\nNext:\n  cd ${result.dir}\n  bun install --frozen-lockfile`);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const projectDirectory = (name: string): string => {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "samva-email";
};

const digest = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const StarterCatalog = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: Schema.String, channel: Schema.String })),
});

export const init = Command.make("init", {
  starter: Flag.String("starter").pipe(
    Flag.withDescription("Gallery starter id (see the template gallery)"),
    Flag.optional,
  ),
  name: Flag.String("name").pipe(Flag.withDescription("Template name")),
  projectName: Flag.String("project-name").pipe(
    Flag.withDescription("Template project name"),
    Flag.optional,
  ),
  slug: Flag.String("slug").pipe(Flag.withDescription("Template handle"), Flag.optional),
  dir: Flag.Directory("dir").pipe(
    Flag.withDescription("Destination directory (defaults to the template name)"),
    Flag.optional,
  ),
  idempotencyKey: Flag.String("idempotency-key").pipe(
    Flag.withDescription("Stable retry key for project creation"),
    Flag.optional,
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Show the project creation request without writing"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create and clone a Samva email starter"),
  Command.withExamples([
    {
      command: 'samva templates init --name "Welcome email"',
      description: "Create a remote project and clone its canonical starter",
    },
    {
      command: 'samva templates init --name "Product newsletter" --starter product-newsletter',
      description: "Create a project from a gallery starter",
    },
    {
      command:
        'samva templates init --name "Welcome email" --slug welcome --dir welcome-email --json',
      description: "Create deterministically for CI or a coding agent",
    },
  ]),
  Command.withHandler(({ name, projectName, slug, dir, starter, idempotencyKey, dryRun, json }) =>
    Effect.gen(function* () {
      const root = resolve(Option.getOrElse(dir, () => projectDirectory(name)));
      const key =
        Option.getOrUndefined(idempotencyKey) ??
        `cli:init:${(yield* Effect.promise(() => digest(`${name}\n${root}${Option.isSome(starter) ? `\n${starter.value}` : ""}`))).slice(0, 48)}`;
      const request = {
        name,
        projectName: Option.getOrUndefined(projectName),
        galleryTemplateId: Option.getOrUndefined(starter),
        slug: Option.getOrUndefined(slug),
      };
      if (dryRun) {
        const result = {
          action: "templates.init",
          dryRun: true,
          dir: root,
          request,
          idempotencyKey: key,
        };
        if (json) return yield* printJson(result);
        return yield* printFields([
          ["Action", "Create and clone template project"],
          ["Directory", root],
          ["Name", request.name],
          ["Project", request.projectName ?? request.name],
          ["Slug", request.slug ?? "Generated by Samva"],
          ["Starter", request.galleryTemplateId ?? "Canonical email starter"],
          ["Idempotency key", key],
        ]);
      }
      if (request.galleryTemplateId !== undefined) {
        const response = yield* getAuthenticatedJson("/v1/starters/");
        const catalog = yield* Schema.decodeUnknownEffect(StarterCatalog)(response).pipe(
          Effect.mapError((error) => toCliApiError("Could not read starter catalog", error)),
        );
        const validIds = catalog.items
          .filter((item) => item.channel === "email")
          .map((item) => item.id);
        if (!validIds.includes(request.galleryTemplateId)) {
          return yield* new CliUsageError({
            code: "unknown_starter",
            message: `Unknown email starter '${request.galleryTemplateId}'. Valid starter ids: ${validIds.join(", ") || "(none)"}.`,
          });
        }
      }
      const client = yield* getClientProvider;
      const created = yield* Templates.create(request, { idempotencyKey: key }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not create template project", error)),
      );
      const result = yield* cloneProject({ id: created.id, dir: root });
      const payload = { ...result, action: "templates.init" as const };
      if (json) return yield* printJson(payload);
      yield* printFields([
        ["Template", payload.templateId],
        ["Project", payload.projectId],
        ["Starter", request.galleryTemplateId ?? "Canonical email starter"],
        ["Directory", payload.dir],
        ["Commit", payload.commit],
      ]);
      yield* Effect.logInfo(`\nNext:\n  cd ${payload.dir}\n  bun install --frozen-lockfile`);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const credentialOperation = Argument.Literals("operation", ["get", "store", "erase"]).pipe(
  Argument.withDescription("Git credential-helper operation"),
);

export const credential = Command.make("credential", {
  id: templateId,
  operation: credentialOperation,
  scope: Flag.Literals("scope", ["read", "write"]).pipe(
    Flag.withDescription("Repository token scope"),
    Flag.withDefault("write"),
  ),
}).pipe(
  Command.unlisted,
  Command.withHandler(({ id, operation, scope }) =>
    Effect.gen(function* () {
      if (operation !== "get") return;
      const input = yield* readStdinUtf8;
      const fields = new Map(
        input
          .split(/\r?\n/)
          .filter((line) => line.length > 0)
          .map((line) => {
            const separator = line.indexOf("=");
            return separator > 0
              ? ([line.slice(0, separator), line.slice(separator + 1)] as const)
              : (["", ""] as const);
          }),
      );
      const protocol = fields.get("protocol");
      const host = fields.get("host");
      const path = fields.get("path");
      if (protocol !== "https" || !host || !path) {
        return yield* new SamvaCliError({
          message: "Git credential request must include an HTTPS host and repository path.",
        });
      }
      const client = yield* getClientProvider;
      const repository = yield* Templates.getGitRepository({ id }).pipe(client.provide);
      const remote = new URL(repository.remote);
      if (remote.host !== host || remote.pathname.replace(/^\//, "") !== path) {
        return yield* new SamvaCliError({
          message: "Git credential request does not match this template project repository.",
        });
      }
      const issued = yield* Templates.issueGitCredential({ id, scope }).pipe(client.provide);
      if (issued.remote !== repository.remote) {
        return yield* new SamvaCliError({ message: "Template repository changed during login." });
      }
      yield* Effect.sync(() =>
        process.stdout.write(
          [
            "protocol=https",
            `host=${host}`,
            `path=${path}`,
            `username=${issued.username}`,
            `password=${issued.password}`,
            "",
            "",
          ].join("\n"),
        ),
      );
    }),
  ),
);

export const gitConfig = (key: string) =>
  runGit(["config", "--local", "--get", key]).pipe(Effect.catch(() => Effect.void));

const projectIdFlag = Flag.String("project-id").pipe(
  Flag.withDescription("Template project id (defaults to the clone's samva.projectId)"),
  Flag.optional,
);

const resolveProjectId = Effect.fn("Templates.resolveProjectId")(function* (
  flag: Option.Option<string>,
) {
  const projectId = Option.getOrUndefined(flag) ?? (yield* gitConfig("samva.projectId"));
  if (!projectId) {
    return yield* new SamvaCliError({
      message:
        "Pass --project-id or run this inside a clone made by `samva templates init` or `samva templates clone`.",
    });
  }
  return projectId;
});

/**
 * The folders a project keeps template entries in, `templates/` first. The CLI ships without
 * the platform's private core package, so this list mirrors `TEMPLATE_ENTRY_ROOTS` there; a
 * platform test keeps the two equal.
 */
export const ENTRY_ROOTS = ["templates", "emails"] as const;
const ENTRY_PATH = new RegExp(`^(?:${ENTRY_ROOTS.join("|")})/.+\\.tsx$`);
const ENTRY_ROOTS_LABEL = ENTRY_ROOTS.map((root) => `${root}/*.tsx`).join(" or ");
const TEMPLATE_SLUG = /^(?=.{1,100}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

const entryPathArgument = (name: string, description: string) =>
  Argument.String(name).pipe(
    Argument.withDescription(description),
    Argument.filterMap(
      (value) => {
        const normalized = value.replace(/^\.\//, "");
        return ENTRY_PATH.test(normalized) ? Option.some(normalized) : Option.none();
      },
      (value) => `${value} is not a ${ENTRY_ROOTS_LABEL} entry path`,
    ),
  );

const humanize = (id: string): string => {
  const words = id.replace(/[-_.]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * The `defineTemplate` id a local entry declares: read from its syntax when it states the id
 * plainly, else from a build of the project, which runs the project's toolchain.
 */
const declaredEntryId = Effect.fn("Templates.declaredEntryId")(function* (entryPath: string) {
  const source = yield* Effect.tryPromise({
    try: () => Bun.file(entryPath).text(),
    catch: (cause) =>
      new SamvaCliError({ message: `Could not read ${entryPath}: ${String(cause)}` }),
  });
  const declared = declaredTemplateId(source);
  if (declared !== undefined) return declared;
  const built = yield* buildDir(undefined, undefined);
  return built.files.find(({ id }) => id === entryPath)?.template?.template;
});

export const add = Command.make("add", {
  entry: entryPathArgument("entry", "Entry file to register, such as templates/reset.tsx"),
  name: Flag.String("name").pipe(
    Flag.withDescription("Template name (defaults from the entry's defineTemplate id)"),
    Flag.optional,
  ),
  slug: Flag.String("slug").pipe(
    Flag.withDescription("Template handle (defaults to the entry's defineTemplate id)"),
    Flag.optional,
  ),
  projectId: projectIdFlag,
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Show the registration request without writing"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Register another template entry in a template project"),
  Command.withExamples([
    {
      command: "samva templates add templates/reset.tsx",
      description: "Register a local entry under the handle its defineTemplate id declares",
    },
    {
      command:
        'samva templates add templates/reset.tsx --slug password-reset --name "Password reset"',
      description: "Register an entry that is not written yet, or override the defaults",
    },
  ]),
  Command.withHandler(({ entry, name, slug, projectId, dryRun, json }) =>
    Effect.gen(function* () {
      const project = yield* resolveProjectId(projectId);
      const explicitSlug = Option.getOrUndefined(slug);
      const explicitName = Option.getOrUndefined(name);
      const declared =
        explicitSlug !== undefined && explicitName !== undefined
          ? undefined
          : (yield* Effect.promise(() => Bun.file(entry).exists()))
            ? yield* declaredEntryId(entry)
            : undefined;
      const resolvedSlug = explicitSlug ?? declared;
      if (resolvedSlug === undefined) {
        return yield* new SamvaCliError({
          message: `${entry} does not build to a defineTemplate template here. Pass --slug and --name to register it before it exists.`,
        });
      }
      if (!TEMPLATE_SLUG.test(resolvedSlug)) {
        return yield* new SamvaCliError({
          message: `defineTemplate id ${JSON.stringify(resolvedSlug)} is not a valid handle (lowercase kebab-case). Pass --slug.`,
        });
      }
      const request = {
        projectId: project,
        entryPath: entry,
        name: explicitName ?? humanize(declared ?? resolvedSlug),
        slug: resolvedSlug,
      };
      if (dryRun) {
        const result = { action: "templates.add", dryRun: true, request };
        if (json) return yield* printJson(result);
        return yield* printFields([
          ["Action", "Register template entry"],
          ["Project", request.projectId],
          ["Entry", request.entryPath],
          ["Name", request.name],
          ["Handle", request.slug],
        ]);
      }
      const client = yield* getClientProvider;
      const { projectId: id, ...entryRequest } = request;
      const added = yield* Templates.addEntry({ id, ...entryRequest }).pipe(
        client.provide,
        Effect.mapError((error) =>
          toCliApiError(
            `Could not register ${entry}${explicitSlug === undefined ? " (pass --slug if the handle is taken)" : ""}`,
            error,
          ),
        ),
      );
      if (json) return yield* printJson(added);
      yield* printFields([
        ["Template", added.id],
        ["Entry", added.entryPath],
        ["Handle", added.slug],
        ["Name", added.name],
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const findEntry = (templates: ReadonlyArray<TemplateRecord>, reference: string) =>
  templates.find(({ id, entryPath }) => id === reference || entryPath === reference);

export const move = Command.make("move", {
  from: Argument.String("from").pipe(Argument.withDescription("Current entry path or template id")),
  to: entryPathArgument("to", "New entry path"),
  projectId: projectIdFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Point a template at another entry file in its project"),
  Command.withExamples([
    {
      command: "samva templates move templates/reset.tsx templates/account/reset.tsx",
      description: "Keep the template's id, handle, and publications after `git mv`",
    },
  ]),
  Command.withHandler(({ from, to, projectId, json }) =>
    Effect.gen(function* () {
      const project = yield* resolveProjectId(projectId);
      const template = findEntry(yield* listProjectTemplates(project), from);
      if (template === undefined) {
        return yield* new SamvaCliError({
          message: `${from} is not a template in project ${project}.`,
        });
      }
      const client = yield* getClientProvider;
      const moved = yield* Templates.update({ id: template.id, data: { entryPath: to } }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not move template entry", error)),
      );
      if (json) return yield* printJson(moved);
      yield* printFields([
        ["Template", moved.id],
        ["Handle", moved.slug],
        ["Entry", moved.entryPath],
      ]);
      yield* Effect.logInfo(
        `\nPublish fails until a pushed commit has ${to}; move the file with \`git mv\` if you have not.`,
      );
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

/**
 * Entry files at `commit` that call `defineTemplate` but are not registered. A textual
 * scan: it needs no installed toolchain, and a helper that happens to mention
 * `defineTemplate` is reported rather than silently hidden. Registration addresses
 * `.tsx` entries under an entry root, so those are the directories scanned.
 */
const unregisteredEntries = Effect.fn("Templates.unregisteredEntries")(function* (
  commit: string,
  templates: ReadonlyArray<TemplateRecord>,
) {
  const matches = yield* runGit([
    "grep",
    "-l",
    "defineTemplate",
    commit,
    "--",
    ...ENTRY_ROOTS.map((root) => `${root}/`),
  ]).pipe(
    // `git grep` exits 1 when nothing matches.
    Effect.catch(() => Effect.succeed("")),
  );
  const registered = new Set(templates.map(({ entryPath }) => entryPath));
  return matches
    .split("\n")
    .map((line) => line.slice(line.indexOf(":") + 1))
    .filter((path) => ENTRY_PATH.test(path) && !registered.has(path));
});

const publishTargets = Effect.fn("Templates.publishTargets")(function* (input: {
  readonly all: boolean;
  readonly reference: string | undefined;
  readonly project: string;
  readonly templates: ReadonlyArray<TemplateRecord>;
}) {
  const active = input.templates.filter(({ isActive }) => isActive);
  if (input.all) {
    if (active.length > 0) return active;
    return yield* new SamvaCliError({
      message: `Project ${input.project} has no active templates.`,
    });
  }
  if (input.reference !== undefined) {
    const template = findEntry(input.templates, input.reference);
    if (template !== undefined) return [template];
    return yield* new SamvaCliError({
      message: `${input.reference} is not a template in project ${input.project}. Register it with \`samva templates add ${input.reference}\`.`,
    });
  }
  if (active.length === 1) return active;
  return yield* new SamvaCliError({
    message: `Project ${input.project} has ${active.length} active templates. Pass an entry path or --all.`,
  });
});

export const publish = Command.make("publish", {
  entry: Argument.String("entry").pipe(
    Argument.withDescription("Entry path or template id to publish"),
    Argument.optional,
  ),
  all: Flag.Boolean("all").pipe(
    Flag.withDescription("Publish every active template in the project at one commit"),
    Flag.withDefault(false),
  ),
  commit: Flag.String("commit").pipe(
    Flag.withDescription("Exact commit or Git revision to publish"),
    Flag.withDefault("HEAD"),
  ),
  projectId: projectIdFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Publish template entries at an exact clean, pushed commit"),
  Command.withExamples([
    {
      command: "samva templates publish templates/reset.tsx",
      description: "Publish one entry at the current commit",
    },
    {
      command: "samva templates publish --all --json",
      description: "Publish every active entry in the project at the current commit",
    },
  ]),
  Command.withHandler(({ entry, all, commit, projectId, json }) =>
    Effect.gen(function* () {
      const reference = Option.getOrUndefined(entry);
      if (all && reference !== undefined) {
        return yield* new CliUsageError({
          code: "publish_target_conflict",
          message: "Pass an entry or --all, not both.",
        });
      }
      const status = yield* runGit(["status", "--porcelain"]);
      if (status.length > 0) {
        return yield* new SamvaCliError({
          message: "Commit or discard every local change before publishing.",
        });
      }
      const project = yield* resolveProjectId(projectId);
      const commitSha = yield* runGit(["rev-parse", `${commit}^{commit}`]);
      yield* runGit(["fetch", "--quiet", "origin"]);
      const templates = yield* listProjectTemplates(project);
      const targets = yield* publishTargets({ all, reference, project, templates });
      const client = yield* getClientProvider;
      const first = targets[0]!;
      const [repository, workspace] = yield* Effect.all(
        [
          Templates.getGitRepository({ id: first.id }).pipe(client.provide),
          Templates.openWorkspace({ id: first.id }).pipe(client.provide),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.mapError((error) => toCliApiError("Could not open the template project", error)),
      );
      yield* runGit([
        "merge-base",
        "--is-ancestor",
        commitSha,
        `refs/remotes/origin/${repository.defaultBranch}`,
      ]).pipe(
        Effect.mapError(
          () =>
            new SamvaCliError({
              message: `Commit ${commitSha} is not on origin/${repository.defaultBranch}. Push it to the template project's default branch before publishing.`,
            }),
        ),
      );
      // Each entry publishes independently; an exact (template, commit, entry) repeat
      // returns its existing receipt, so rerunning after a partial failure is safe.
      const results = yield* Effect.forEach(targets, (template) =>
        Templates.publish({
          id: template.id,
          projectId: project,
          commitSha,
          entryPath: template.entryPath,
          expectedWorkspaceRevision: workspace.workspace.revision,
        }).pipe(
          client.provide,
          Effect.match({
            onSuccess: (publication) => ({
              templateId: template.id,
              slug: template.slug,
              entryPath: template.entryPath,
              ok: true as const,
              publicationId: publication.id,
              status: publication.status,
            }),
            onFailure: (error) => ({
              templateId: template.id,
              slug: template.slug,
              entryPath: template.entryPath,
              ok: false as const,
              error: formatApiError("Could not publish", error),
            }),
          }),
        ),
      );
      const unregistered = all ? yield* unregisteredEntries(commitSha, templates) : [];
      const result = {
        action: "templates.publish",
        commitSha,
        publications: results,
        unregistered,
      };
      const lines = [
        ...results.map((item) =>
          item.ok
            ? `published     ${item.entryPath}  ${item.slug}  ${item.publicationId}`
            : `failed        ${item.entryPath}  ${item.slug}  ${item.error}`,
        ),
        ...unregistered.map(
          (path) => `unregistered  ${path}  (samva templates add ${path} to publish it)`,
        ),
      ];
      const failed = results.filter(({ ok }) => !ok).length;
      if (failed > 0) {
        return yield* new CliResultError({
          code: "template_publish_failed",
          message: `${failed} of ${results.length} entries did not publish at ${commitSha}.`,
          result,
          human: lines.join("\n"),
        });
      }
      if (json) return yield* printJson(result);
      yield* Effect.logInfo(`Commit ${commitSha}\n${lines.join("\n")}`);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
