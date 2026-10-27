import { pathToFileURL } from "node:url";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { SamvaCliError } from "../../errors";
import { AUTHORING_MINOR, minorOf } from "../../lib/authoring-release";
import { ApiUrl, Org, Profile } from "../../lib/runtime";
// Bun embeds the CLI-owned resolver in both JavaScript and native artifacts.
// oxlint-disable-next-line import/default -- Bun's text loader imports the module source as a string, independently of its exports.
import brandResolverSource from "./brand-resolver.ts" with { type: "text" };

/** The packages a template project installs so the CLI can load its pinned toolchain. */
export const TOOLCHAIN_INSTALL = "npm install --save-dev @samva/markup @samva/vite vite";

const AUTHORING_PACKAGES = ["@samva/markup", "@samva/vite"] as const;

/**
 * Why a project's installed authoring packages cannot be driven by this CLI, or `undefined` when
 * each one is on the CLI's release line. The CLI runs its own brand resolver and build options
 * against the project's compiler, so a different line fails inside the compiler with an error
 * that names neither side.
 */
export const toolchainSkew = (
  installed: Readonly<Record<string, string | undefined>>,
  action: string,
): string | undefined => {
  for (const name of AUTHORING_PACKAGES) {
    const version = installed[name];
    if (version === undefined || minorOf(version) === AUTHORING_MINOR) continue;
    const behind = Number(minorOf(version).split(".")[1]) < Number(AUTHORING_MINOR.split(".")[1]);
    return behind
      ? `${action}: this project has ${name} ${version}, but this CLI drives ${AUTHORING_MINOR}.x. Update the project with \`npm install --save-dev @samva/markup@~${AUTHORING_MINOR}.0 @samva/vite@~${AUTHORING_MINOR}.0\`.`
      : `${action}: this project has ${name} ${version}, which is newer than the ${AUTHORING_MINOR}.x this CLI drives. Update the CLI with \`npm install -g @samva/cli@latest\`.`;
  }
  return undefined;
};

/** The authoring package versions installed in the project at `root`; a package it lacks is absent. */
const installedAuthoring = async (root: string): Promise<Record<string, string | undefined>> =>
  Object.fromEntries(
    await Promise.all(
      AUTHORING_PACKAGES.map(async (name) => {
        const manifest = await Promise.resolve()
          .then(
            async () =>
              (await Bun.file(Bun.resolveSync(`${name}/package.json`, root)).json()) as {
                version?: string;
              },
          )
          .catch(() => undefined);
        return [name, manifest?.version] as const;
      }),
    ),
  );

/** Refuse a project whose authoring packages are on another release line than this CLI. */
export const requireCompatibleToolchain = (action: string): Effect.Effect<void, SamvaCliError> =>
  Effect.tryPromise({
    try: () => installedAuthoring(process.cwd()),
    catch: () =>
      new SamvaCliError({ message: `${action}: could not read the project's installed packages.` }),
  }).pipe(
    Effect.flatMap((installed) => {
      const skew = toolchainSkew(installed, action);
      return skew === undefined ? Effect.void : Effect.fail(new SamvaCliError({ message: skew }));
    }),
  );

const MISSING_MODULE = /Cannot find (?:package|module) '([^']+)'/;

/**
 * A subprocess failure, turned into the message a developer acts on. A package the project does
 * not install names the install command; anything else is the process's own stderr.
 */
export const toolchainFailure = (stderr: string, action: string): string => {
  const missing = MISSING_MODULE.exec(stderr)?.[1];
  if (stderr.includes("`vite` is required")) {
    return `${action}: vite is not installed in this project. Install the authoring toolchain with \`${TOOLCHAIN_INSTALL}\`.`;
  }
  if (missing !== undefined && /^(@samva\/|vite)/.test(missing)) {
    return `${action}: ${missing} is not installed in this project. Install the authoring toolchain with \`${TOOLCHAIN_INSTALL}\`.`;
  }
  return `${action}: ${stderr.trim() || "the toolchain process failed."}`;
};

/**
 * The credential selection this invocation was given with `--profile`, `--org`, and `--api-url`, as
 * the `SAMVA_*` variables. A live `samva:brand` lookup runs inside the toolchain process and may ask
 * a `samva` on PATH for the brand, which has none of this invocation's flags but reads these.
 */
export const invocationEnv = Effect.gen(function* () {
  const profile = Option.getOrUndefined(yield* Profile);
  const org = Option.getOrUndefined(yield* Org);
  const apiUrl = Option.getOrUndefined(yield* ApiUrl);
  return {
    ...(profile === undefined ? {} : { SAMVA_PROFILE: profile }),
    ...(org === undefined ? {} : { SAMVA_ORG: org }),
    ...(apiUrl === undefined ? {} : { SAMVA_API_URL: apiUrl }),
  } satisfies Record<string, string>;
});

/** A toolchain step: it reads this invocation's global flags, so its context is not empty. */
export type ToolchainEffect<A> = Effect.Effect<
  A,
  SamvaCliError,
  Effect.Services<typeof invocationEnv>
>;

const NODE_MISSING = "Install Node.js 22+ to run template authoring commands.";

/**
 * Runs a module script under Node.js in the project directory, so bare imports resolve from the
 * project's own installed `@samva/vite` and `@samva/markup`. The script reads its options from
 * `SAMVA_TOOLCHAIN_INPUT` (a JSON value) and writes one JSON value to stdout.
 */
export const runToolchain = <A>(input: {
  readonly script: string;
  readonly options: unknown;
  readonly action: string;
}) =>
  Effect.gen(function* () {
    yield* requireCompatibleToolchain(input.action);
    const selection = yield* invocationEnv;
    return yield* Effect.tryPromise({
      try: async (): Promise<A> => {
        const child = Bun.spawn(["node", "--input-type=module", "--eval", input.script], {
          cwd: process.cwd(),
          env: { ...Bun.env, ...selection, SAMVA_TOOLCHAIN_INPUT: JSON.stringify(input.options) },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (exitCode !== 0) {
          return Promise.reject(
            new SamvaCliError({ message: toolchainFailure(stderr, input.action) }),
          );
        }
        return JSON.parse(stdout) as A;
      },
      catch: (cause) =>
        cause instanceof SamvaCliError
          ? cause
          : new SamvaCliError({
              message: `${input.action}: ${NODE_MISSING} ${String(cause)}`,
            }),
    });
  });

/** A module script prelude: the JSON options `runToolchain` passes in. */
export const OPTIONS_PRELUDE = "const options = JSON.parse(process.env.SAMVA_TOOLCHAIN_INPUT);";

/** Runs the CLI-owned resolver with the project's installed authoring dependencies. */
export const brandResolverPrelude =
  (): string => `${new Bun.Transpiler({ loader: "ts" }).transformSync(brandResolverSource)}
const brandEnv = await loadBrandEnv(options.root);
options.brandResolver = createBrandResolver({ root: options.root, env: brandEnv, offline: options.offline });
options.brandPlugin = samvaBrandPlugin;
options.authenticated = Boolean(brandEnv.SAMVA_API_KEY);
options.editorAffordances = {
  publishingInstructions: {
    reason: "Test sends run against a published template on Samva. Commit and push this file, run samva templates publish --commit HEAD, then send it by its template ID.",
    cta: { label: "How publishing works", href: "https://samva.dev/docs/sml/authoring-tsx" },
  },
  authenticatedLabel: "API key set",
  authenticatedTitle: "SAMVA_API_KEY is set — authenticated affordances are available.",
};
delete options.offline;`;

/** Load the CLI resolver for a Bun watch session with the project's pinned compiler. */
export const loadSamvaBrandResolver = async (
  root: string,
): Promise<typeof import("./brand-resolver")> => {
  const source = new Bun.Transpiler({ loader: "ts" })
    .transformSync(brandResolverSource)
    .replaceAll(
      '"@samva/markup/brand"',
      JSON.stringify(pathToFileURL(Bun.resolveSync("@samva/markup/brand", root)).href),
    )
    .replaceAll(
      '"@samva/markup/compiler"',
      JSON.stringify(pathToFileURL(Bun.resolveSync("@samva/markup/compiler", root)).href),
    );
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
};
