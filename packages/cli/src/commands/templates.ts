import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  formatReportedDiagnostic,
  type ReportedDiagnostic,
} from "@samva/core/shared/template-diagnostics";
import type { BuildTemplatesResult, TemplateBuildSession } from "@samva/vite/build";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Templates from "samva/effect/templates";

import { CliResultError, CliUsageError, SamvaCliError, toCliApiError } from "../errors";
import { getClientProvider } from "../lib/client";
import { confirmDestructive } from "../lib/confirm";
import { namespaceField, namespaceFlag } from "../lib/namespace";
import { jsonFlag, objectRows, printFields, printJson, printJsonLine } from "../lib/output";
import { isJsonLinesRequested, outputModeFromArgv } from "../lib/runtime";
import { devCommand } from "./templates/dev-command";
import { reportDiagnostic } from "./templates/diagnostics";
import { assetBaseFlag, dirFlag } from "./templates/flags";
import { fromWebsiteCommand } from "./templates/from-website-command";
import { buildDir } from "./templates/local-build";
import { exportProject } from "./templates/local-export";
import { add, clone, credential, init, move, publish } from "./templates/project";
import { renderCommand } from "./templates/render-command";
import { snapshotCommand } from "./templates/snapshot-command";
import {
  invocationEnv,
  loadSamvaBrandResolver,
  requireCompatibleToolchain,
  toolchainFailure,
  type ToolchainEffect,
} from "./templates/toolchain";
import { typesCommand } from "./templates/types-command";
import { workspaceCommand } from "./templates/workspace";

/**
 * `samva templates init/clone/dev/check/render/snapshot/build/publish` — the
 * local-repository authoring workflow for TSX templates. `init` and `clone` materialize
 * a canonical Git-backed project; `check` and `build` validate local TSX without
 * writing to the platform; `publish` publishes one exact, clean Git commit.
 *
 * Project metadata remains available through list/get/create/update/remove for
 * automation that needs it. Source history and publication are Git operations.
 */

const tsconfigFlag = Flag.String("tsconfig").pipe(
  Flag.withDescription("TypeScript project used to check authored templates"),
  Flag.withDefault("tsconfig.json"),
);

const dryRunFlag = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Show the request without calling the API"),
  Flag.withDefault(false),
);

const templateIdArgument = Argument.String("id").pipe(
  Argument.withDescription("Remote template id"),
);
const parseObject = (raw: string, flag: string) =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: () => new SamvaCliError({ message: `${flag} must be a valid JSON object.` }),
  }).pipe(
    Effect.filterOrFail(
      (value): value is Record<string, unknown> =>
        Predicate.isObject(value) && !Array.isArray(value),
      () => new SamvaCliError({ message: `${flag} must be a non-null JSON object.` }),
    ),
  );
const decodePayload = <A>(raw: string, flag: string, schema: Schema.Codec<A, unknown>) =>
  parseObject(raw, flag).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError((error) =>
      error instanceof SamvaCliError
        ? error
        : new SamvaCliError({ message: `${flag} does not match the API schema: ${String(error)}` }),
    ),
  );

const createProjectBuildSession = (dir: string | undefined, assetBase: string | undefined) =>
  Effect.gen(function* () {
    yield* requireCompatibleToolchain(
      `Could not start template watch${dir === undefined ? "" : ` in ${dir}`}`,
    );
    const selection = yield* invocationEnv;
    return yield* Effect.tryPromise({
      try: async (): Promise<TemplateBuildSession> => {
        const entry = Bun.resolveSync("@samva/vite/build", process.cwd());
        const projectBuild = (await import(
          pathToFileURL(entry).href
        )) as typeof import("@samva/vite/build");
        const { createBrandResolver, loadBrandEnv } = await loadSamvaBrandResolver(process.cwd());
        const projectBrand = await import(
          pathToFileURL(Bun.resolveSync("@samva/markup/brand", process.cwd())).href
        );
        return projectBuild.createTemplateBuildSession({
          brandResolver: createBrandResolver({
            root: process.cwd(),
            env: { ...(await loadBrandEnv(process.cwd())), ...selection },
          }),
          brandPlugin: projectBrand.samvaBrandPlugin,
          root: process.cwd(),
          ...(dir === undefined ? {} : { dir: resolve(dir) }),
          ...(assetBase === undefined ? {} : { assetBase }),
        });
      },
      catch: (cause) =>
        new SamvaCliError({
          message: toolchainFailure(
            String(cause),
            `Could not start template watch${dir === undefined ? "" : ` in ${dir}`}`,
          ),
        }),
    });
  });

interface TypeScriptDiagnostic {
  readonly file: string;
  readonly code: string;
  readonly message: string;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
}

interface TypeScriptCheckResult {
  readonly version: string;
  readonly diagnostics: readonly TypeScriptDiagnostic[];
}

// `tsc --pretty false` prints `file(line,col): error TSnnnn: message`; global
// diagnostics such as TS18003 omit the file prefix entirely.
const TSC_DIAGNOSTIC_LINE = /^(?:(.*?)(?:\((\d+),(\d+)\))?: )?(?:error )?(TS\d+): (.*)$/;

/**
 * `samva:brand` is a module the compiler generates, and an imported image or font is a module only
 * Vite's client declarations describe, so `tsc` knows both through ambient declarations a project
 * lists in its tsconfig. Without them it prints a bare "Cannot find module", which does not say
 * where the declaration lives.
 */
const BRAND_MODULE_NOT_FOUND = /^Cannot find module 'samva:brand(?:\/[^']*)?'/;
const ASSET_MODULE_NOT_FOUND = /^Cannot find module '[^']+\.(?:png|jpe?g|gif|webp|woff2)'/;

const withTypesHint = (message: string, tsconfig: string): string => {
  const types = BRAND_MODULE_NOT_FOUND.test(message)
    ? "@samva/markup/samva-brand"
    : ASSET_MODULE_NOT_FOUND.test(message)
      ? "vite/client"
      : undefined;
  return types === undefined
    ? message
    : `${message} Add "${types}" to compilerOptions.types in ${basename(tsconfig)}.`;
};

/** Parses `tsc --pretty false` output; a line that is not a diagnostic is reported verbatim. */
export const parseTypeScriptDiagnostics = (
  output: string,
  tsconfig: string,
): ReadonlyArray<TypeScriptDiagnostic> =>
  output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): TypeScriptDiagnostic => {
      const match = TSC_DIAGNOSTIC_LINE.exec(line);
      return match === null
        ? { file: tsconfig, code: "TSC", message: line }
        : {
            file: match[1] ?? tsconfig,
            code: match[4] ?? "TSC",
            message: withTypesHint(match[5] ?? line, tsconfig),
            ...(match[2] === undefined ? {} : { line: Number(match[2]) }),
            ...(match[3] === undefined ? {} : { column: Number(match[3]) }),
          };
    });

/** Runs the project's own TypeScript before evaluating any authored module. */
const typecheckProject = (tsconfig: string): Effect.Effect<TypeScriptCheckResult, SamvaCliError> =>
  Effect.tryPromise({
    try: async () => {
      const typescriptPackage = Bun.resolveSync("typescript/package.json", process.cwd());
      const tsc = resolve(dirname(typescriptPackage), "bin/tsc");
      const typescriptManifest = (await Bun.file(typescriptPackage).json()) as { version?: string };
      const child = Bun.spawn(
        ["node", tsc, "--noEmit", "--pretty", "false", "--project", resolve(tsconfig)],
        { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      const output = `${stdout}${stderr}`.trim();
      const diagnostics = parseTypeScriptDiagnostics(output, resolve(tsconfig));
      if (exitCode !== 0 && diagnostics.length === 0) {
        return Promise.reject(
          new SamvaCliError({
            message:
              output ||
              `Could not run TypeScript from this project. Install typescript and check ${tsconfig}.`,
          }),
        );
      }
      return { version: typescriptManifest.version ?? "unknown", diagnostics };
    },
    catch: (cause) =>
      cause instanceof SamvaCliError
        ? cause
        : new SamvaCliError({
            message: `Could not type-check ${tsconfig} with this project's TypeScript installation: ${String(cause)}`,
          }),
  });

const validateTemplatesDir = (dir: string): Effect.Effect<void, SamvaCliError> =>
  Effect.tryPromise({
    try: async () => {
      const info = await stat(dir);
      if (!info.isDirectory()) {
        return Promise.reject(new SamvaCliError({ message: `${dir} is not a directory.` }));
      }
      await access(dir, constants.R_OK);
    },
    catch: (cause) => {
      if (cause instanceof SamvaCliError) return cause;
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return new SamvaCliError({ message: `Template directory ${dir} does not exist.` });
      }
      if (code === "EACCES" || code === "EPERM") {
        return new SamvaCliError({ message: `Template directory ${dir} is not readable.` });
      }
      return new SamvaCliError({
        message: `Could not read template directory ${dir}: ${String(cause)}`,
      });
    },
  });

type TemplateCheckPhase = "typescript" | "compile" | "compatibility" | "project" | "watch";

/** A finding that fails a check or build: the reported diagnostic plus where it arose. */
export interface TemplateCheckProblem extends ReportedDiagnostic {
  readonly phase: TemplateCheckPhase;
  readonly provenance: "tsx";
}

const problemOf = (
  phase: TemplateCheckPhase,
  diagnostic: Parameters<typeof reportDiagnostic>[0],
  context: { readonly file: string; readonly fixture?: string | undefined },
): TemplateCheckProblem => ({
  ...reportDiagnostic(diagnostic, context),
  phase,
  provenance: "tsx",
});

const compatibilityFindings = (
  result: BuildTemplatesResult,
  severity: "error" | "warning",
): ReadonlyArray<TemplateCheckProblem> =>
  result.files.flatMap((file) =>
    (file.template?.compatibility ?? [])
      .filter((diagnostic) => diagnostic.severity === severity)
      .map((diagnostic) => problemOf("compatibility", diagnostic, { file: file.id })),
  );

/** Compile warnings that are not client-compatibility findings. */
const compileWarnings = (result: BuildTemplatesResult): ReadonlyArray<TemplateCheckProblem> =>
  result.files.flatMap((file) =>
    file.diagnostics
      .filter((diagnostic) => diagnostic.severity === "warning")
      .map((diagnostic) => problemOf("compile", diagnostic, { file: file.id })),
  );

/** Every error that fails a local check: project, compile, fixture and compatibility findings. */
export const collectBuildProblems = (
  result: BuildTemplatesResult,
): ReadonlyArray<TemplateCheckProblem> => [
  ...result.diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => problemOf("project", diagnostic, { file: "." })),
  ...result.files.flatMap((file) => [
    ...file.diagnostics
      .filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) => problemOf("compile", diagnostic, { file: file.id })),
    ...(file.template?.fixtures ?? []).flatMap((fixture) =>
      fixture.diagnostics
        .filter((diagnostic) => diagnostic.severity === "error")
        .map((diagnostic) =>
          problemOf("compile", diagnostic, { file: file.id, fixture: fixture.name }),
        ),
    ),
  ]),
  ...compatibilityFindings(result, "error"),
];

export const isSuccessfulBuild = (result: BuildTemplatesResult): boolean =>
  result.files.length > 0 && result.ok && collectBuildProblems(result).length === 0;

export interface TemplateBuildArtifact {
  readonly schemaVersion: 4;
  readonly compilerVersion: string;
  readonly result: BuildTemplatesResult;
}

export const toTemplateBuildArtifact = (result: BuildTemplatesResult): TemplateBuildArtifact => ({
  schemaVersion: 4,
  compilerVersion: result.compilerVersion,
  result,
});

const NO_TEMPLATES = (dir: string | undefined): string =>
  `No templates found in ${dir ?? "templates/ or emails/"}. A template is a .tsx file that default-exports defineTemplate with an input schema, fixtures, and an email, sms, or whatsapp body.`;

// ── check ─────────────────────────────────────────────────────────────────────

interface TemplateCheckObservation {
  readonly ok: boolean;
  readonly message: string;
  readonly problems: readonly TemplateCheckProblem[];
  readonly payload: Readonly<Record<string, unknown>>;
}

const observeTemplateCheck = (
  dir: string | undefined,
  tsconfig: string,
  build: () => ToolchainEffect<BuildTemplatesResult>,
): ToolchainEffect<TemplateCheckObservation> =>
  Effect.gen(function* () {
    const typecheck = yield* typecheckProject(tsconfig);
    const typeProblems: readonly TemplateCheckProblem[] = typecheck.diagnostics.map(
      (diagnostic) => ({
        file: diagnostic.file,
        phase: "typescript",
        provenance: "tsx",
        code: diagnostic.code,
        severity: "error",
        message: diagnostic.message,
        line: diagnostic.line,
        column: diagnostic.column,
      }),
    );
    const typeFailure = (): TemplateCheckObservation => ({
      ok: false,
      message: `TypeScript check failed (${typeProblems.length} problem(s)).`,
      problems: typeProblems,
      payload: {
        action: "templates.check",
        ok: false,
        phase: "typescript",
        tsconfig,
        typescriptVersion: typecheck.version,
        problems: typeProblems,
      },
    });
    // The compiler reads templates without running them, so it still reports on a project that
    // fails the TypeScript check; its findings carry the fix or upgrade recipe a type error lacks.
    // When the compiler cannot run there, the type errors are still the answer.
    const attempted =
      typeProblems.length > 0
        ? yield* build().pipe(
            Effect.asSome,
            Effect.catchTag("SamvaCliError", () =>
              Effect.succeed(Option.none<BuildTemplatesResult>()),
            ),
          )
        : Option.some(yield* build());
    if (Option.isNone(attempted)) return typeFailure();
    const built = attempted.value;
    const buildProblems = collectBuildProblems(built);
    if (typeProblems.length > 0 && built.files.length === 0 && buildProblems.length === 0) {
      return typeFailure();
    }
    const problems = [...typeProblems, ...buildProblems];
    const ok = typeProblems.length === 0 && isSuccessfulBuild(built);
    const compilerVersion = built.compilerVersion;
    const warnings = compatibilityFindings(built, "warning");
    const failureMessage = (): string => {
      if (typeProblems.length > 0) {
        return `TypeScript check failed (${typeProblems.length} problem(s)); template check found ${problems.length - typeProblems.length} more.`;
      }
      if (built.files.length === 0) return NO_TEMPLATES(dir);
      return `Template check failed (${problems.length} problem(s)).`;
    };
    const message = ok
      ? `TypeScript v${typecheck.version} · compiler ${compilerVersion} · ${built.files.length} template(s) compiled · ${warnings.length} compatibility warning(s)`
      : failureMessage();
    return {
      ok,
      message,
      problems,
      payload: {
        action: "templates.check",
        ok,
        phase: ok ? "complete" : typeProblems.length > 0 ? "typescript" : "templates",
        tsconfig,
        typescriptVersion: typecheck.version,
        compilerVersion,
        buildSchemaVersion: 4,
        files: built.files,
        problems,
        warnings: compileWarnings(built),
        compatibility: {
          errors: problems.filter((problem) => problem.phase === "compatibility").length,
          warnings: warnings.length,
          findings: warnings,
        },
      },
    };
  });

const watchTemplateChecks = (
  dir: string | undefined,
  tsconfig: string,
  assetBase: string | undefined,
): ToolchainEffect<void> =>
  Effect.acquireUseRelease(
    createProjectBuildSession(dir, assetBase),
    (session) => {
      let sequence = 0;

      const build = (): Effect.Effect<BuildTemplatesResult, SamvaCliError> =>
        Effect.tryPromise({
          try: () => session.build(),
          catch: (cause) =>
            new SamvaCliError({ message: `Could not rebuild templates: ${String(cause)}` }),
        });
      const observe = () =>
        observeTemplateCheck(dir, tsconfig, build).pipe(
          Effect.catch((error) => {
            const problem: TemplateCheckProblem = {
              file: dir ?? ".",
              phase: "watch",
              provenance: "tsx",
              code: "watch-rebuild-error",
              severity: "error",
              message: error.message,
            };
            return Effect.succeed({
              ok: false,
              message: error.message,
              problems: [problem],
              payload: {
                action: "templates.check",
                ok: false,
                phase: "watch",
                problems: [problem],
              },
            });
          }),
        );
      const emit = (observation: TemplateCheckObservation): Effect.Effect<void, SamvaCliError> => {
        sequence += 1;
        if (isJsonLinesRequested()) {
          const files = observation.payload["files"] as BuildTemplatesResult["files"] | undefined;
          return printJsonLine({
            ...observation.payload,
            message: observation.message,
            ...(files === undefined
              ? {}
              : {
                  files: files.map((file) => ({
                    id: file.id,
                    kind: file.kind,
                    ok: file.ok,
                    ...(file.template === undefined
                      ? {}
                      : {
                          template: file.template.template,
                          channels: file.template.channels,
                        }),
                  })),
                }),
            observation: sequence,
            observedAt: new Date().toISOString(),
          });
        }
        if (outputModeFromArgv(process.argv.slice(2)) === "quiet") return Effect.void;
        return Effect.sync(() => {
          const status = observation.ok ? "✓" : "✗";
          process.stdout.write(`${status} ${observation.message}\n`);
          for (const problem of observation.problems) {
            process.stdout.write(`  ${formatReportedDiagnostic(problem)}\n`);
          }
        });
      };

      // The listener is registered before the first check is queued, so an edit
      // made during that check still schedules another. Changes settle for 75ms,
      // and changes that arrive while a check runs coalesce into one follow-up.
      return Stream.callback<void>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const unsubscribe = session.subscribe(() => Queue.offerUnsafe(queue, undefined));
            Queue.offerUnsafe(queue, undefined);
            return unsubscribe;
          }),
          (unsubscribe) => Effect.sync(unsubscribe),
        ),
      ).pipe(
        Stream.debounce("75 millis"),
        Stream.buffer({ capacity: 1, strategy: "sliding" }),
        Stream.runForEach(() => Effect.flatMap(observe(), emit)),
      );
    },
    (session) => Effect.promise(() => session.close()),
  );

const check = Command.make("check", {
  dir: dirFlag,
  json: jsonFlag,
  tsconfig: tsconfigFlag,
  assetBase: assetBaseFlag,
  watch: Flag.Boolean("watch").pipe(
    Flag.withDescription("Continuously re-run checks as project files change"),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Type-check and compile local TSX templates, render every fixture, and report located findings",
  ),
  Command.withExamples([
    {
      command: "samva templates check",
      description: "Check the templates in templates/ and emails/ without writing files",
    },
    {
      command: "samva templates check --json",
      description: "Print the check result as JSON",
    },
    {
      command: "samva templates check --asset-base https://cdn.example.com/email",
      description: "Check imported assets against their actual HTTPS serving base",
    },
    {
      command: "samva templates check --tsconfig tsconfig.templates.json",
      description: "Use a dedicated TypeScript project",
    },
    {
      command: "samva templates check --watch",
      description: "Continuously check templates and dependencies",
    },
    {
      command: "samva templates check --watch --jsonl",
      description: "Stream one machine-readable result per observation",
    },
  ]),
  Command.withHandler(({ dir, json, tsconfig, watch, assetBase }) =>
    Effect.gen(function* () {
      const dirValue = Option.getOrUndefined(dir);
      if (dirValue !== undefined) yield* validateTemplatesDir(dirValue);
      // Before TypeScript: a type-checked project hides a failed build, and on another release
      // line the type errors are noise while the version is the answer.
      yield* requireCompatibleToolchain(
        `Could not check templates${dirValue === undefined ? "" : ` in ${dirValue}`}`,
      );
      if (watch) {
        if (json && !isJsonLinesRequested()) {
          return yield* new CliUsageError({
            code: "watch_requires_jsonl",
            message: "--watch uses --jsonl for machine output; --json remains one-shot.",
          });
        }
        return yield* watchTemplateChecks(dirValue, tsconfig, Option.getOrUndefined(assetBase));
      }

      const observation = yield* observeTemplateCheck(dirValue, tsconfig, () =>
        buildDir(dirValue, Option.getOrUndefined(assetBase)),
      );
      if (!observation.ok) {
        if (json) {
          return yield* new CliResultError({
            code: "template_check_failed",
            message: observation.message,
            result: observation.payload,
            human: observation.message,
          });
        }
        for (const problem of observation.problems) {
          yield* Console.error(formatReportedDiagnostic(problem));
        }
        return yield* new SamvaCliError({ message: observation.message });
      }

      if (json) {
        yield* printJson(observation.payload);
      } else {
        yield* Effect.logInfo(observation.message);
      }
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

// ── build ─────────────────────────────────────────────────────────────────────

const writeJsonFile = (
  target: string,
  value: unknown,
): Effect.Effect<void, SamvaCliError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dirname(target), { recursive: true });
    yield* fs.writeFileString(target, `${JSON.stringify(value, null, 2)}\n`);
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SamvaCliError({
          message: `Could not write ${target}: ${String(cause)}`,
        }),
    ),
  );

const build = Command.make("build", {
  dir: dirFlag,
  assetBase: assetBaseFlag,
  out: Flag.File("out").pipe(
    Flag.withDescription("Write the compiled local template artifact as JSON"),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Build local TSX templates into a reusable JSON artifact"),
  Command.withExamples([
    {
      command: "samva templates build --out dist/templates.json",
      description: "Compile local templates for another package or deployment step",
    },
    {
      command:
        "samva templates build --out dist/templates.json --asset-base https://cdn.example.com/email",
      description: "Build executable fixtures with their imported asset URLs",
    },
  ]),
  Command.withHandler(({ dir, out, json, assetBase }) =>
    Effect.gen(function* () {
      const dirValue = Option.getOrUndefined(dir);
      const built = yield* buildDir(dirValue, Option.getOrUndefined(assetBase));
      const problems = collectBuildProblems(built);
      if (!isSuccessfulBuild(built)) {
        const message =
          built.files.length === 0
            ? NO_TEMPLATES(dirValue)
            : `Template build failed (${problems.length} problem(s)).`;
        if (json) {
          return yield* new CliResultError({
            code: "template_build_failed",
            message,
            result: {
              action: "templates.build",
              ok: false,
              problems,
            },
            human: message,
          });
        }
        for (const problem of problems) {
          yield* Console.error(formatReportedDiagnostic(problem));
        }
        return yield* new SamvaCliError({ message });
      }

      const target = resolve(out);
      const artifact = toTemplateBuildArtifact(built);
      yield* writeJsonFile(target, artifact);
      const result = {
        action: "templates.build",
        ok: true,
        compilerVersion: artifact.compilerVersion,
        files: built.files.length,
        out: target,
      };
      if (json) {
        yield* printJson(result);
      } else {
        yield* Effect.logInfo(
          `Built ${built.files.length} template file(s) with compiler ${artifact.compilerVersion} to ${target}`,
        );
      }
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

// ── remote lifecycle ───────────────────────────────────────────────────────

const sharedFilterFlag = Flag.Literals("shared", ["true", "false"]).pipe(
  Flag.withDescription(
    "Only templates shared with every namespace (true), or only unshared ones (false)",
  ),
  Flag.optional,
);

const listRemote = Command.make("list", {
  cursor: Flag.String("cursor").pipe(
    Flag.withDescription("Resume after this nextCursor from a previous page"),
    Flag.optional,
  ),
  limit: Flag.Int("limit").pipe(Flag.withDescription("Items per page"), Flag.optional),
  namespace: namespaceFlag("list"),
  shared: sharedFilterFlag,
  all: Flag.Boolean("all").pipe(
    Flag.withDescription("Traverse every page (requires --jsonl)"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List remote templates"),
  Command.withExamples([
    { command: "samva templates list --json" },
    { command: "samva templates list --shared true --json" },
  ]),
  Command.withHandler(({ cursor, limit, namespace, shared, all, json }) =>
    Effect.gen(function* () {
      if (all && !isJsonLinesRequested())
        return yield* new CliUsageError({
          code: "all_requires_jsonl",
          message: "--all is an unbounded traversal and requires --jsonl.",
        });
      const client = yield* getClientProvider;
      const cursorValue = Option.getOrUndefined(cursor);
      const limitValue = Option.getOrUndefined(limit);
      const query = {
        cursor: cursorValue,
        limit: limitValue,
        ...namespaceField(namespace),
        ...Option.match(shared, {
          onNone: () => ({}),
          onSome: (value) => ({ shared: value === "true" }),
        }),
      };
      if (all) {
        let nextCursor = cursorValue;
        for (;;) {
          const data = yield* Templates.list({ ...query, cursor: nextCursor }).pipe(
            client.provide,
            Effect.mapError((error) => toCliApiError("Could not list templates", error)),
          );
          for (const item of data.items) yield* printJsonLine(item);
          if (data.nextCursor === null) return;
          nextCursor = data.nextCursor;
        }
      }
      const data = yield* Templates.list(query).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not list templates", error)),
      );
      if (isJsonLinesRequested()) {
        for (const item of data.items) yield* printJsonLine(item);
        return;
      }
      if (json) return yield* printJson(data);
      for (const item of data.items)
        yield* printFields([
          ["ID", item.id],
          ["Name", item.name],
          ["Slug", item.slug],
          ["Status", item.status],
          ["Namespace", item.namespaceId ?? "organization"],
          ["Shared", item.shared ? "yes" : "no"],
        ]);
      if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const getRemote = Command.make("get", { id: templateIdArgument, json: jsonFlag }).pipe(
  Command.withDescription("Get a remote template"),
  Command.withExamples([{ command: "samva templates get tmpl_abc123 --json" }]),
  Command.withHandler(({ id, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Templates.getById({ id }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not get template", error)),
      );
      if (json) return yield* printJson(data);
      yield* printFields(objectRows(data));
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const createRemote = Command.make("create", {
  data: Flag.String("data").pipe(Flag.withDescription("Complete template JSON payload")),
  namespace: namespaceFlag("create"),
  idempotencyKey: Flag.String("idempotency-key").pipe(
    Flag.withSchema(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255))),
    Flag.withDescription("Stable retry key; generated per call when omitted"),
    Flag.optional,
  ),
  shared: Flag.Boolean("shared").pipe(
    Flag.withDescription(
      "Share the new organization-level project with every namespace; namespace-scoped keys read and send it but cannot change it",
    ),
    Flag.withDefault(false),
  ),
  dryRun: dryRunFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create a remote template from JSON"),
  Command.withExamples([
    {
      command: `samva templates create --data '{"name":"Welcome","projectName":"welcome-email"}' --dry-run`,
    },
  ]),
  Command.withHandler(({ data, namespace, idempotencyKey, shared, dryRun, json }) =>
    Effect.gen(function* () {
      const decoded = yield* decodePayload(data, "--data", Templates.CreatePayload);
      if (shared && decoded.shared === false)
        return yield* new CliUsageError({
          code: "shared_conflict",
          message: "--shared and shared: false in --data disagree.",
        });
      if (shared && (Option.isSome(namespace) || decoded.namespaceId != null))
        return yield* new CliUsageError({
          code: "shared_namespace_conflict",
          message: "--shared shares an organization-level project; it cannot have a namespace.",
        });
      if (
        Option.isSome(namespace) &&
        decoded.namespaceId != null &&
        decoded.namespaceId !== namespace.value
      )
        return yield* new CliUsageError({
          code: "namespace_conflict",
          message: "--namespace and the namespaceId in --data name different namespaces.",
        });
      const payload = {
        ...decoded,
        ...namespaceField(namespace),
        ...(shared ? { shared: true } : {}),
      };
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "templates.create", request: payload })
          : printFields([
              ["Action", "templates.create"],
              ...objectRows(payload, { explicit: true }),
            ]);
      const client = yield* getClientProvider;
      const result = yield* Templates.create(payload, {
        idempotencyKey: Option.getOrUndefined(idempotencyKey),
      }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not create template", error)),
      );
      if (json) return yield* printJson(result);
      yield* printFields(objectRows(result));
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const updateRemote = Command.make("update", {
  id: templateIdArgument,
  data: Flag.String("data").pipe(Flag.withDescription("JSON object of template fields to update")),
  shared: Flag.Literals("shared", ["true", "false"]).pipe(
    Flag.withDescription(
      "Share the template's organization-level project with every namespace (true) or stop sharing it (false); applies to every entry in the project",
    ),
    Flag.optional,
  ),
  dryRun: dryRunFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Update a remote template from JSON"),
  Command.withExamples([
    {
      command: `samva templates update tmpl_abc123 --data '{"name":"Welcome back"}' --dry-run`,
    },
  ]),
  Command.withHandler(({ id, data, shared, dryRun, json }) =>
    Effect.gen(function* () {
      const parsed = yield* parseObject(data, "--data");
      const sharedValue = Option.map(shared, (value) => value === "true");
      if (
        Option.isSome(sharedValue) &&
        parsed.shared !== undefined &&
        parsed.shared !== sharedValue.value
      )
        return yield* new CliUsageError({
          code: "shared_conflict",
          message: "--shared and shared in --data disagree.",
        });
      const changes = Option.isSome(sharedValue)
        ? { ...parsed, shared: sharedValue.value }
        : parsed;
      const payload = yield* decodePayload(
        JSON.stringify({ data: changes }),
        "--data",
        Templates.UpdatePayload,
      );
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "templates.update", id, request: payload })
          : printFields([
              ["Action", "templates.update"],
              ["Template", id],
              ...objectRows(payload, { explicit: true }),
            ]);
      const client = yield* getClientProvider;
      const result = yield* Templates.update({ id, ...payload }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not update template", error)),
      );
      if (json) return yield* printJson(result);
      yield* printFields(objectRows(result));
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const removeRemote = Command.make("remove", {
  id: templateIdArgument,
  dryRun: dryRunFlag,
  yes: Flag.Boolean("yes").pipe(
    Flag.withDescription("Confirm destructive state change"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Deactivate a remote template; its project file and publications remain"),
  Command.withExamples([{ command: "samva templates remove tmpl_abc123 --dry-run" }]),
  Command.withHandler(({ id, dryRun, yes, json }) =>
    Effect.gen(function* () {
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "templates.remove", id })
          : Console.log(`[dry-run] Would remove template ${id}.`);
      yield* confirmDestructive({
        yes,
        json,
        message: `Deactivate template ${id}?`,
        nonInteractiveMessage:
          "remove requires --yes in non-interactive mode. Preview with --dry-run.",
      });
      const client = yield* getClientProvider;
      const result = yield* Templates.remove({ id }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not remove template", error)),
      );
      if (json) return yield* printJson(result);
      yield* printFields([
        ["Template", id],
        ["Removed", result.success],
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const exportCommand = Command.make("export", {
  dir: dirFlag,
  out: Flag.Directory("out").pipe(
    Flag.withDescription("Directory to write rendered fixtures, assets, and the catalog into"),
  ),
  assetBase: Flag.String("asset-base").pipe(
    Flag.withDescription(
      "Origin the exported assets will be served from; omit to point each exported page at the export's own assets directory",
    ),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Render every local template's fixtures to HTML, text, SMS, WhatsApp files, and assets",
  ),
  Command.withExamples([
    {
      command: "samva templates export --out dist/email",
      description:
        "Render fixtures for review, images resolving from the export's assets directory",
    },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ dir, out, assetBase, json }) {
      const receipt = yield* exportProject({
        dir: Option.getOrUndefined(dir),
        out,
        assetBase: Option.getOrUndefined(assetBase),
      });
      const errors = receipt.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
      const result = {
        action: "templates.export",
        ok: errors.length === 0,
        out: resolve(out),
        assetBase: receipt.assets.base,
        templates: receipt.templates.map((template) => ({
          id: template.id,
          entryPath: template.entryPath,
          fixtures: template.fixtures.map((fixture) => fixture.fixture),
        })),
        assets: receipt.assets.assets.length,
        diagnostics: receipt.diagnostics.map((diagnostic) =>
          reportDiagnostic(diagnostic, { file: "." }),
        ),
      };
      if (errors.length > 0) {
        const message = `Template export found ${errors.length} error(s).`;
        return yield* new CliResultError({
          code: "template_export_failed",
          message,
          result,
          human: message,
        });
      }
      if (json) return yield* printJson(result);
      yield* printFields([
        ["Out", result.out],
        ["Asset base", result.assetBase],
        ["Assets", result.assets],
        ...result.templates.map(
          (template) =>
            [
              "Template",
              `${template.id}  ${template.entryPath}  fixtures: ${template.fixtures.join(", ")}`,
            ] as const,
        ),
      ]);
      for (const diagnostic of result.diagnostics) {
        yield* Console.error(formatReportedDiagnostic(diagnostic));
      }
    }),
  ),
);

export const templatesCommand = Command.make("templates").pipe(
  Command.withDescription("Create, author, check, and publish Git-backed template projects"),
  Command.withExamples([
    {
      command: 'samva templates init --name "Welcome email"',
      description: "Create and clone the canonical template project",
    },
    {
      command: "samva templates clone tmpl_abc123 --dir welcome-email",
      description: "Clone an existing project with its repository credential helper",
    },
    {
      command: "samva templates from-website example.com",
      description:
        "Create a project from a website and print the editor link that matches its brand",
    },
    {
      command: "samva templates dev",
      description: "Start the local visual editor for templates/ and emails/",
    },
    {
      command: "samva templates check",
      description: "Check local TSX templates without writing files",
    },
    {
      command: "samva templates render welcome --fixture default",
      description: "Print one fixture's subject, preheader and plain-text body",
    },
    {
      command: "samva templates snapshot welcome --fixture default",
      description: "Screenshot one fixture at desktop and mobile widths, light and dark",
    },
    {
      command: "samva templates publish --commit HEAD",
      description: "Publish the current clean commit, then continue with ordinary Git",
    },
    {
      command: "samva templates export --out dist/email",
      description: "Render every template's fixtures to HTML, text, and assets",
    },
    {
      command: "samva templates types --out src/samva-templates.ts",
      description: "Generate typed inputs pinned to each template's current publication",
    },
  ]),
  Command.withSubcommands([
    clone,
    credential,
    init,
    add,
    move,
    publish,
    listRemote,
    getRemote,
    createRemote,
    updateRemote,
    removeRemote,
    fromWebsiteCommand,
    devCommand,
    check,
    renderCommand,
    snapshotCommand,
    build,
    exportCommand,
    typesCommand,
    workspaceCommand,
  ]),
);
