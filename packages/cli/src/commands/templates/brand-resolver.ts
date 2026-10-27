import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { samvaBrandPlugin, type EmailBrand } from "@samva/markup/brand";
import { parseBrandSpecifier, projectBrandSpecifier } from "@samva/markup/compiler";
import type { EmailDiagnostic } from "@samva/markup/diagnostics";
import type { BrandResolver } from "@samva/vite/project";

type ProjectFiles = Parameters<BrandResolver["resolve"]>[0];

const isObject = (input: unknown): input is { [key: PropertyKey]: unknown } =>
  // oxlint-disable-next-line samva/no-hand-rolled-object-guard -- The embedded resolver loads without Effect; the brand reader validates each required field after this structural narrowing.
  typeof input === "object" && input !== null && !Array.isArray(input);

// A project that imports `samva:brand` compiles against its organization's
// brand, which lives in the Samva API rather than in the repository. Resolution
// prefers the live brand and falls back to the snapshot `samva brands pull`
// wrote, so a build works offline and says when it is using a copy:
//
//   1. Live, with credentials the environment already holds: `SAMVA_API_KEY`
//      (and `SAMVA_API_URL`) fetch the brand directly; otherwise the `samva`
//      CLI on PATH answers `samva brands get --json` with its own login, so the
//      OAuth session stays in the operating-system keyring the CLI owns.
//      A live answer refreshes the copy in `.samva/brands/<slug>.json`.
//   2. The cached copy at `.samva/brands/<slug>.json`, with a warning.
//   3. Neither: the build fails and names both ways to fix it.
//
// `.samva/` is the folder for files this package generates; it is gitignored.

/** Where brand records are cached, relative to the project root. */
export const BRAND_SNAPSHOT_DIR = ".samva/brands";

const SNAPSHOT_VERSION = 1;
const DEFAULT_API_URL = "https://api.samva.dev";
const LIVE_TIMEOUT_MS = 15_000;
/** How long a resolution is reused, so a watch loop does not ask the API on every save. */
const RESOLUTION_TTL_MS = 30_000;

/** A brand as a build compiles it, with the digest the API knows its content by. */
export interface ResolvedBrand extends EmailBrand {
  readonly digest: string;
}

/** The cached copy of a brand record, written by a live fetch or `samva brands pull`. */
export interface BrandSnapshot extends ResolvedBrand {
  readonly version: typeof SNAPSHOT_VERSION;
  readonly name: string;
  readonly isDefault: boolean;
  /** ISO timestamp of the pull. */
  readonly pulledAt: string;
}

type BrandWarningCode = "brand-snapshot-stale" | "brand-offline";

export interface BrandWarning {
  readonly code: BrandWarningCode;
  readonly message: string;
}

export type BrandResolution =
  | {
      readonly ok: true;
      /** `undefined` when the project imports no brand. */
      readonly brand: ResolvedBrand | undefined;
      readonly source: "live" | "snapshot" | "none";
      readonly warnings: readonly BrandWarning[];
    }
  | { readonly ok: false; readonly message: string };

export interface ResolveProjectBrandInput {
  readonly root: string;
  readonly files: ProjectFiles;
  /** Project-relative theme path; `undefined` when theming is disabled. */
  readonly themePath?: string | undefined;
  /** Environment holding `SAMVA_API_KEY`, `SAMVA_API_URL` and `PATH`; see `loadBrandEnv`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Skip the live fetch and resolve from the cached copy. */
  readonly offline?: boolean | undefined;
}

type Env = Readonly<Record<string, string | undefined>>;
type Live =
  | { readonly ok: true; readonly brand: BrandSnapshot }
  | { readonly ok: false; readonly reason: string };

/** Accept only the fields a build needs, from an API body or a snapshot file. */
const asBrand = (value: unknown): Omit<BrandSnapshot, "version" | "pulledAt"> | undefined => {
  if (!isObject(value)) return undefined;
  const { slug, name, isDefault, css, assets, footer, digest } = value;
  if (
    typeof slug !== "string" ||
    typeof name !== "string" ||
    typeof isDefault !== "boolean" ||
    typeof css !== "string" ||
    typeof digest !== "string" ||
    (assets !== undefined && !isObject(assets)) ||
    (footer !== undefined && !isObject(footer))
  )
    return undefined;
  return {
    slug,
    name,
    isDefault,
    css,
    digest,
    ...(assets === undefined ? {} : { assets: assets as EmailBrand["assets"] }),
    ...(footer === undefined ? {} : { footer: footer as EmailBrand["footer"] }),
  };
};

const liveFromBody = (body: unknown, when: string): Live => {
  const brand = asBrand(body);
  return brand === undefined
    ? { ok: false, reason: `${when} answered with something that is not a brand` }
    : { ok: true, brand: { ...brand, version: SNAPSHOT_VERSION, pulledAt: "" } };
};

const fetchJson = async (url: string, apiKey: string): Promise<unknown> => {
  const response = await fetch(url, {
    headers: { "x-api-key": apiKey, accept: "application/json" },
    signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
  });
  if (!response.ok)
    // oxlint-disable-next-line samva/no-try-catch-or-throw, samva/no-error-constructor -- Caught below and reported as the reason the live brand is unavailable.
    throw new Error(`${url} answered ${response.status}`);
  return response.json();
};

const liveWithApiKey = async (slug: string | undefined, env: Env, apiKey: string) => {
  const base = (env["SAMVA_API_URL"] || DEFAULT_API_URL).replace(/\/+$/, "");
  // oxlint-disable-next-line samva/no-try-catch-or-throw -- A network or HTTP failure is an offline answer, not a crash.
  try {
    if (slug !== undefined)
      return liveFromBody(await fetchJson(`${base}/v1/brands/${slug}`, apiKey), "The Samva API");
    const body = await fetchJson(`${base}/v1/brands`, apiKey);
    const items = isObject(body) && Array.isArray(body["items"]) ? body["items"] : [];
    const found = items.find((item) => isObject(item) && item["isDefault"] === true);
    return found === undefined
      ? ({ ok: false, reason: "the organization has no default brand" } satisfies Live)
      : liveFromBody(found, "The Samva API");
  } catch (cause) {
    return {
      ok: false,
      reason: `the Samva API did not answer (${cause instanceof Error ? cause.message : String(cause)})`,
    } satisfies Live;
  }
};

/** The CLI's error envelope message, or its raw stderr. */
const cliFailure = (stderr: string): string => {
  const parsed = ((): unknown => {
    // oxlint-disable-next-line samva/no-try-catch-or-throw -- Human-mode stderr is not JSON; fall back to the text.
    try {
      return JSON.parse(stderr);
    } catch {
      return undefined;
    }
  })();
  return isObject(parsed) && typeof parsed["message"] === "string"
    ? parsed["message"]
    : stderr.trim() || "it exited without a message";
};

const liveWithCli = (slug: string | undefined, env: Env): Promise<Live> =>
  new Promise((resolve) => {
    execFile(
      "samva",
      ["brands", "get", ...(slug === undefined ? [] : [slug]), "--json"],
      { env: { ...env }, timeout: LIVE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          const code = (error as NodeJS.ErrnoException).code;
          resolve({
            ok: false,
            reason:
              code === "ENOENT"
                ? "there is no SAMVA_API_KEY and no `samva` CLI on PATH"
                : `\`samva brands get\` failed: ${cliFailure(stderr)}`,
          });
          return;
        }
        const envelope = ((): unknown => {
          // oxlint-disable-next-line samva/no-try-catch-or-throw -- A malformed answer is reported as the reason, like any other.
          try {
            return JSON.parse(stdout);
          } catch {
            return undefined;
          }
        })();
        resolve(
          liveFromBody(isObject(envelope) ? envelope["data"] : undefined, "`samva brands get`"),
        );
      },
    );
  });

const fetchLiveBrand = (slug: string | undefined, env: Env): Promise<Live> => {
  const apiKey = env["SAMVA_API_KEY"];
  return apiKey !== undefined && apiKey.length > 0
    ? liveWithApiKey(slug, env, apiKey)
    : liveWithCli(slug, env);
};

type SnapshotRead =
  | { readonly ok: true; readonly snapshot: BrandSnapshot | undefined; readonly path: string }
  | { readonly ok: false; readonly message: string };

const readSnapshotFile = async (path: string): Promise<SnapshotRead> => {
  const raw = await readFile(path, "utf8").catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return undefined;
    // oxlint-disable-next-line samva/no-try-catch-or-throw -- A filesystem failure must not read as a missing snapshot.
    throw cause;
  });
  if (raw === undefined) return { ok: true, snapshot: undefined, path };
  const parsed = ((): unknown => {
    // oxlint-disable-next-line samva/no-try-catch-or-throw -- A corrupt snapshot is reported below with the fix.
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  })();
  const brand = asBrand(parsed);
  if (
    brand === undefined ||
    !isObject(parsed) ||
    parsed["version"] !== SNAPSHOT_VERSION ||
    typeof parsed["pulledAt"] !== "string"
  )
    return {
      ok: false,
      message: `${path} is not a brand snapshot this version of @samva/cli reads. Run \`samva brands pull\` to rewrite it.`,
    };
  return {
    ok: true,
    snapshot: { ...brand, version: SNAPSHOT_VERSION, pulledAt: parsed["pulledAt"] },
    path,
  };
};

/**
 * The snapshot for a named brand, or for the default brand the most recently
 * pulled snapshot that was the default when it was pulled.
 */
const readSnapshot = async (root: string, slug: string | undefined): Promise<SnapshotRead> => {
  const directory = join(root, BRAND_SNAPSHOT_DIR);
  if (slug !== undefined) return readSnapshotFile(join(directory, `${slug}.json`));
  const names = await readdir(directory).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return [];
    // oxlint-disable-next-line samva/no-try-catch-or-throw -- A filesystem failure must not read as a missing snapshot.
    throw cause;
  });
  const reads = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => readSnapshotFile(join(directory, name))),
  );
  const failed = reads.find((read) => !read.ok);
  if (failed !== undefined) return failed;
  const defaults = reads.flatMap((read) =>
    read.ok && read.snapshot?.isDefault === true ? [{ ...read, snapshot: read.snapshot }] : [],
  );
  defaults.sort((a, b) => b.snapshot.pulledAt.localeCompare(a.snapshot.pulledAt));
  return defaults[0] ?? { ok: true, snapshot: undefined, path: directory };
};

const SAFE_SLUG = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Refresh the cached copy after a live answer. Best effort: a read-only checkout
 * or a full disk must not fail a build that already has the brand it needs.
 */
const cacheBrand = async (
  root: string,
  brand: BrandSnapshot,
  cached: BrandSnapshot | undefined,
): Promise<void> => {
  if (!SAFE_SLUG.test(brand.slug) || cached?.digest === brand.digest) return;
  const directory = join(root, BRAND_SNAPSHOT_DIR);
  const target = join(directory, `${brand.slug}.json`);
  const snapshot: BrandSnapshot = { ...brand, pulledAt: new Date().toISOString() };
  const temporary = `${target}.${process.pid}.tmp`;
  await mkdir(directory, { recursive: true })
    .then(() => writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8"))
    .then(() => rename(temporary, target))
    .catch(() => undefined);
};

const toResolved = (brand: BrandSnapshot): ResolvedBrand => ({
  slug: brand.slug,
  css: brand.css,
  digest: brand.digest,
  ...(brand.assets === undefined ? {} : { assets: brand.assets }),
  ...(brand.footer === undefined ? {} : { footer: brand.footer }),
});

const relativeSnapshot = (root: string, path: string): string =>
  relative(root, path).split(sep).join("/");

/**
 * Resolve the brand a project's `samva:brand` import names: live when the
 * environment's credentials reach the API, else the pulled snapshot with a
 * warning, else a failure naming both fixes.
 */
export const resolveProjectBrand = async (
  input: ResolveProjectBrandInput,
): Promise<BrandResolution> => {
  const specifier = projectBrandSpecifier(input.files, {
    themePath: input.themePath ?? "",
    brandPlugin: samvaBrandPlugin,
  });
  if (specifier === undefined) return { ok: true, brand: undefined, source: "none", warnings: [] };
  const slug = parseBrandSpecifier(specifier, { brandPlugin: samvaBrandPlugin })?.slug;
  const pullCommand = `samva brands pull${slug === undefined ? "" : ` ${slug}`}`;
  const [live, local] = await Promise.all([
    input.offline === true
      ? Promise.resolve<Live>({ ok: false, reason: "offline mode skips the live brand" })
      : fetchLiveBrand(slug, input.env),
    readSnapshot(input.root, slug),
  ]);
  if (live.ok) {
    const cached = local.ok ? local.snapshot : undefined;
    const stale = cached !== undefined && cached.digest !== live.brand.digest;
    await cacheBrand(input.root, live.brand, cached);
    return {
      ok: true,
      brand: toResolved(live.brand),
      source: "live",
      warnings: stale
        ? [
            {
              code: "brand-snapshot-stale",
              message: `${relativeSnapshot(input.root, local.ok ? local.path : input.root)} was older than the live brand ${live.brand.slug}; the cached copy is refreshed.`,
            },
          ]
        : [],
    };
  }
  if (!local.ok) return { ok: false, message: local.message };
  if (local.snapshot === undefined)
    return {
      ok: false,
      message: `The project imports ${specifier}, but ${live.reason}, and there is no snapshot in ${BRAND_SNAPSHOT_DIR}. Run \`samva login\` or set SAMVA_API_KEY, or run \`${pullCommand}\` while online.`,
    };
  return {
    ok: true,
    brand: toResolved(local.snapshot),
    source: "snapshot",
    warnings: [
      {
        code: "brand-offline",
        message: `Using ${relativeSnapshot(input.root, local.path)} (pulled ${local.snapshot.pulledAt}) for ${specifier}: ${live.reason}.`,
      },
    ],
  };
};

/**
 * The environment a local build resolves the brand with: the process
 * environment plus the project's `.env` files, as the editor's dev server
 * reads them, so `SAMVA_API_KEY` in `.env` reaches `check` and `export` too.
 */
export const loadBrandEnv = async (
  root: string,
): Promise<Readonly<Record<string, string | undefined>>> => {
  const vite: typeof import("vite") | undefined = await Promise.resolve()
    .then(
      () => import(pathToFileURL(createRequire(join(root, "package.json")).resolve("vite")).href),
    )
    .catch(() => undefined);
  if (vite === undefined)
    // oxlint-disable-next-line samva/no-try-catch-or-throw, samva/no-error-constructor -- Plain library boundary: the optional `vite` peer is missing and the caller surfaces a user-facing message.
    throw new Error("`vite` is required to resolve samva:brand locally.");
  return vite.loadEnv("development", root, "");
};

/** The resolution as build findings: warnings stay warnings, a failure is an error. */
export const brandDiagnostics = (resolution: BrandResolution): EmailDiagnostic[] =>
  resolution.ok
    ? resolution.warnings.map((warning) => ({
        code: warning.code,
        severity: "warning",
        message: warning.message,
        origins: [],
      }))
    : [{ code: "brand-unavailable", severity: "error", message: resolution.message, origins: [] }];

/**
 * One resolver per watch session. A resolution is reused for a short while per
 * specifier, so saving a file does not ask the API each time while a brand
 * edited elsewhere still arrives within the window.
 */
export const createBrandResolver = (options: {
  readonly root: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly offline?: boolean | undefined;
}): BrandResolver => {
  const cache = new Map<string, { readonly at: number; readonly resolution: BrandResolution }>();
  return {
    resolve: async (files, themePath) => {
      const key =
        projectBrandSpecifier(files, {
          themePath: themePath ?? "",
          brandPlugin: samvaBrandPlugin,
        }) ?? "";
      const cached = cache.get(key);
      if (cached !== undefined && Date.now() - cached.at < RESOLUTION_TTL_MS)
        return cached.resolution;
      const resolution = await resolveProjectBrand({
        root: options.root,
        files,
        themePath,
        env: options.env,
        offline: options.offline,
      });
      cache.set(key, { at: Date.now(), resolution });
      return resolution;
    },
  };
};
