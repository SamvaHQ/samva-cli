import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The browser-driving half of `samva templates snapshot`. A `Launcher` turns a rendered page into
// PNGs; `takeSnapshots` plans the viewport and color-scheme grid and asks each launcher in turn,
// so the unit tests inject one and need no browser.

export const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
} as const;
export const SCHEMES = ["light", "dark"] as const;

export type ViewportName = keyof typeof VIEWPORTS;
export type SchemeName = (typeof SCHEMES)[number];

/** One screenshot: the page on disk, the window it renders in, and where the PNG goes. */
export interface ShotRequest {
  readonly htmlPath: string;
  readonly viewport: ViewportName;
  readonly width: number;
  readonly height: number;
  readonly scheme: SchemeName;
  readonly outFile: string;
}

type LauncherResult =
  | { readonly status: "done" }
  | { readonly status: "unavailable"; readonly reason: string };

export interface Launcher {
  readonly name: string;
  /** Capture every request as a full-page PNG, or report why this launcher cannot run. */
  readonly capture: (requests: readonly ShotRequest[]) => Promise<LauncherResult>;
}

export const BROWSER_REMEDY =
  "Install a browser to screenshot with: add `playwright` to this project (`npm install --save-dev playwright && npx playwright install chromium`), or install Google Chrome or Chromium and set SAMVA_CHROME to its executable path if it is not in the usual location.";

export const snapshotFileName = (
  template: string,
  fixture: string,
  viewport: ViewportName,
  scheme: SchemeName,
): string => `${template}-${fixture}-${viewport}-${scheme}.png`;

interface SnapshotFile {
  readonly viewport: ViewportName;
  readonly scheme: SchemeName;
  readonly width: number;
  readonly path: string;
}

export interface SnapshotInput {
  readonly html: string;
  readonly template: string;
  readonly fixture: string;
  readonly outDir: string;
  readonly viewports: readonly ViewportName[];
  readonly schemes: readonly SchemeName[];
  readonly launchers: readonly Launcher[];
}

export type SnapshotResult =
  | { readonly ok: true; readonly browser: string; readonly files: readonly SnapshotFile[] }
  | { readonly ok: false; readonly reasons: readonly string[] };

/** Write the page, then let the first launcher that can run capture the whole grid. */
export const takeSnapshots = async (input: SnapshotInput): Promise<SnapshotResult> => {
  await mkdir(input.outDir, { recursive: true });
  const scratch = await mkdtemp(join(tmpdir(), "samva-snapshot-"));
  const htmlPath = join(scratch, "page.html");
  await writeFile(htmlPath, input.html);
  const requests = input.viewports.flatMap((viewport) =>
    input.schemes.map((scheme): ShotRequest => ({
      htmlPath,
      viewport,
      width: VIEWPORTS[viewport].width,
      height: VIEWPORTS[viewport].height,
      scheme,
      outFile: join(
        input.outDir,
        snapshotFileName(input.template, input.fixture, viewport, scheme),
      ),
    })),
  );
  const reasons: string[] = [];
  // oxlint-disable-next-line samva/no-try-catch-or-throw -- Adapter boundary: the scratch page is removed whether or not a launcher throws.
  try {
    for (const launcher of input.launchers) {
      // oxlint-disable-next-line no-await-in-loop -- Launchers are tried in order until one runs.
      const outcome = await launcher.capture(requests);
      if (outcome.status === "done")
        return {
          ok: true,
          browser: launcher.name,
          files: requests.map(({ viewport, scheme, width, outFile }) => ({
            viewport,
            scheme,
            width,
            path: outFile,
          })),
        };
      reasons.push(`${launcher.name}: ${outcome.reason}`);
    }
    return { ok: false, reasons };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

// ── Chrome or Chromium binary ────────────────────────────────────────────────

const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
];
const CHROME_COMMANDS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

/** `SAMVA_CHROME`, else the first browser found at the usual locations. */
export const findChrome = (
  env: Readonly<Record<string, string | undefined>>,
  which: (command: string) => string | null = (command) => Bun.which(command),
  exists: (path: string) => boolean = existsSync,
): string | undefined => {
  const override = env["SAMVA_CHROME"];
  if (override !== undefined && override !== "") return override;
  return (
    CHROME_PATHS.find((path) => exists(path)) ??
    CHROME_COMMANDS.map((command) => which(command)).find((path) => path !== null) ??
    undefined
  );
};

/** Flags for one headless screenshot at an exact window size. */
export const chromeScreenshotArgs = (input: {
  readonly profile: string;
  readonly width: number;
  readonly height: number;
  readonly scheme: SchemeName;
  readonly outFile: string;
  readonly url: string;
}): string[] => [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--disable-background-networking",
  "--disable-component-update",
  "--no-first-run",
  "--no-default-browser-check",
  `--user-data-dir=${input.profile}`,
  `--window-size=${input.width},${input.height}`,
  // preferredColorScheme: 0 is light, 1 is dark.
  `--blink-settings=preferredColorScheme=${input.scheme === "dark" ? 1 : 0}`,
  `--screenshot=${input.outFile}`,
  input.url,
];

/** Flags to dump the DOM of the page after it has recorded its own height. */
const chromeMeasureArgs = (input: {
  readonly profile: string;
  readonly width: number;
  readonly height: number;
  readonly scheme: SchemeName;
  readonly url: string;
}): string[] => [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--disable-background-networking",
  "--disable-component-update",
  "--no-first-run",
  "--no-default-browser-check",
  `--user-data-dir=${input.profile}`,
  `--window-size=${input.width},${input.height}`,
  `--blink-settings=preferredColorScheme=${input.scheme === "dark" ? 1 : 0}`,
  "--dump-dom",
  input.url,
];

const MEASURE_SCRIPT =
  "<script>addEventListener('load',()=>{document.documentElement.setAttribute('data-samva-height',String(Math.ceil(Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0))))})</script>";

/** The page with a script that records its scroll height on the root element. */
export const withMeasurement = (html: string): string =>
  /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, `${MEASURE_SCRIPT}</body>`)
    : `${html}${MEASURE_SCRIPT}`;

export const parseMeasuredHeight = (dom: string): number | undefined => {
  const height = /data-samva-height="(\d+)"/.exec(dom)?.[1];
  return height === undefined ? undefined : Number(height);
};

/** When a one-shot browser run has produced what it was started for. */
interface RunUntil {
  /** A file that exists and is non-empty. */
  readonly file?: string | undefined;
  /** Text that has appeared on stdout. */
  readonly stdoutIncludes?: string | undefined;
}

export type RunProcess = (
  command: string,
  args: readonly string[],
  until: RunUntil,
) => Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>;

const RUN_TIMEOUT_MS = 30_000;
const POLL_MS = 100;

/**
 * Chrome's headless one-shot modes can leave the process running after the screenshot is written
 * or the DOM is dumped, so the run ends when the output is there, not when the process exits.
 */
const runProcess: RunProcess = async (command, args, until) => {
  const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
  let stdout = "";
  let stderr = "";
  const drain = async (stream: ReadableStream<Uint8Array>, sink: (text: string) => void) => {
    for await (const chunk of stream) sink(Buffer.from(chunk).toString());
  };
  void drain(child.stdout, (text) => {
    stdout += text;
  });
  void drain(child.stderr, (text) => {
    stderr += text;
  });
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  const produced = async (): Promise<boolean> =>
    (until.stdoutIncludes !== undefined && stdout.includes(until.stdoutIncludes)) ||
    (until.file !== undefined && existsSync(until.file) && (await stat(until.file)).size > 0);
  const state = { exited: false };
  void child.exited.then(() => {
    state.exited = true;
  });
  // oxlint-disable no-await-in-loop -- Polling for output the browser is still producing.
  while (!state.exited && Date.now() < deadline && !(await produced())) {
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
  // oxlint-enable no-await-in-loop
  if (!state.exited) {
    // A file appears before its last bytes are flushed.
    await new Promise((done) => setTimeout(done, POLL_MS * 3));
    child.kill("SIGKILL");
  }
  await child.exited;
  return { code: state.exited ? child.exitCode : null, stdout, stderr };
};

/** Drives a system Chrome or Chromium with `--headless --screenshot`. */
export const chromeLauncher = (
  binary: string | undefined,
  run: RunProcess = runProcess,
): Launcher => ({
  name: "Chrome",
  capture: async (requests) => {
    if (binary === undefined)
      return {
        status: "unavailable",
        reason: "no Chrome or Chromium found in the usual locations and SAMVA_CHROME is not set",
      };
    const profile = await mkdtemp(join(tmpdir(), "samva-chrome-"));
    // oxlint-disable-next-line samva/no-try-catch-or-throw -- Adapter boundary: the browser profile is removed whether or not a run throws.
    try {
      // oxlint-disable no-await-in-loop -- Each shot launches its own headless browser in turn.
      for (const request of requests) {
        const source = await readFile(request.htmlPath, "utf8");
        const measured = request.htmlPath.replace(
          /\.html$/,
          `.${request.viewport}.${request.scheme}.html`,
        );
        await writeFile(measured, withMeasurement(source));
        const measure = await run(
          binary,
          chromeMeasureArgs({
            profile,
            width: request.width,
            height: request.height,
            scheme: request.scheme,
            url: pathToFileURL(measured).href,
          }),
          { stdoutIncludes: "</html>" },
        );
        const height = Math.max(
          request.height,
          parseMeasuredHeight(measure.stdout) ?? request.height,
        );
        // Chrome writes to a fresh path, so an image from a previous run can neither satisfy the
        // completion check nor be lost when this capture fails.
        const staged = join(profile, `shot-${request.viewport}-${request.scheme}.png`);
        const shot = await run(
          binary,
          chromeScreenshotArgs({
            profile,
            width: request.width,
            height,
            scheme: request.scheme,
            outFile: staged,
            url: pathToFileURL(request.htmlPath).href,
          }),
          { file: staged },
        );
        if (!existsSync(staged))
          return {
            status: "unavailable",
            reason: `${binary} did not produce a screenshot (exit ${shot.code ?? "killed"}): ${shot.stderr.trim().split("\n").slice(-3).join(" ")}`,
          };
        await copyFile(staged, request.outFile);
      }
      // oxlint-enable no-await-in-loop
      return { status: "done" };
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  },
});

// ── Playwright from the project ──────────────────────────────────────────────

/**
 * Runs under Node.js in the project, so `playwright` or `playwright-core` resolves from the
 * project's own install. Prints `{ status }` as JSON.
 */
const PLAYWRIGHT_SCRIPT = `
const options = JSON.parse(process.env.SAMVA_TOOLCHAIN_INPUT);
const load = async () => {
  for (const name of ["playwright", "playwright-core"]) {
    try { return await import(name); } catch {}
  }
  return undefined;
};
const done = (value) => process.stdout.write(JSON.stringify(value));
const playwright = await load();
if (playwright === undefined) {
  done({ status: "unavailable", reason: "neither playwright nor playwright-core is installed in this project" });
} else {
  const chromium = playwright.chromium ?? playwright.default?.chromium;
  let browser;
  let failure = "";
  for (const launch of [{}, { channel: "chrome" }]) {
    try { browser = await chromium.launch(launch); break; } catch (error) { failure = String(error?.message ?? error).split("\\n")[0]; }
  }
  if (browser === undefined) {
    done({ status: "unavailable", reason: "playwright could not launch a browser (" + failure + ")" });
  } else {
    try {
      for (const request of options.requests) {
        const context = await browser.newContext({
          viewport: { width: request.width, height: request.height },
          colorScheme: request.scheme,
        });
        const page = await context.newPage();
        await page.goto(options.urls[request.htmlPath]);
        await page.screenshot({ path: request.outFile, fullPage: true });
        await context.close();
      }
      done({ status: "done" });
    } finally {
      await browser.close();
    }
  }
}
`;

/** Drives the `playwright` (or `playwright-core`) the project installs, through a Node.js subprocess. */
const playwrightLauncher = (): Launcher => ({
  name: "Playwright",
  capture: async (requests) => {
    const urls = Object.fromEntries(
      [...new Set(requests.map((request) => request.htmlPath))].map((path) => [
        path,
        pathToFileURL(path).href,
      ]),
    );
    const child = Bun.spawn(["node", "--input-type=module", "--eval", PLAYWRIGHT_SCRIPT], {
      cwd: process.cwd(),
      env: { ...Bun.env, SAMVA_TOOLCHAIN_INPUT: JSON.stringify({ requests, urls }) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0)
      return {
        status: "unavailable",
        reason: stderr.trim().split("\n").slice(-3).join(" ") || `node exited ${code}`,
      };
    return JSON.parse(stdout) as LauncherResult;
  },
});

/** The launchers `samva templates snapshot` tries, in order. */
export const defaultLaunchers = (env: Readonly<Record<string, string | undefined>>): Launcher[] => [
  playwrightLauncher(),
  chromeLauncher(findChrome(env)),
];
