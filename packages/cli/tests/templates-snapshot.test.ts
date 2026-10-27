import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  chromeLauncher,
  chromeScreenshotArgs,
  findChrome,
  type Launcher,
  parseMeasuredHeight,
  type ShotRequest,
  snapshotFileName,
  takeSnapshots,
  withMeasurement,
} from "../src/commands/templates/snapshot-browser";
import {
  toolchainFailure,
  toolchainSkew,
  TOOLCHAIN_INSTALL,
} from "../src/commands/templates/toolchain";
import { AUTHORING_MINOR } from "../src/lib/authoring-release";

const dirs: string[] = [];
const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "samva-snapshot-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("takeSnapshots", () => {
  it("plans the viewport and scheme grid and names each file", async () => {
    const seen: ShotRequest[] = [];
    const launcher: Launcher = {
      name: "Fake",
      capture: async (requests) => {
        seen.push(...requests);
        for (const request of requests) await writeFile(request.outFile, "png");
        return { status: "done" };
      },
    };
    const outDir = await scratch();
    const result = await takeSnapshots({
      html: "<html></html>",
      template: "welcome",
      fixture: "no-tracking",
      outDir,
      viewports: ["desktop", "mobile"],
      schemes: ["light", "dark"],
      launchers: [launcher],
    });
    expect(result).toMatchObject({ ok: true, browser: "Fake" });
    expect(seen.map((request) => [request.viewport, request.width, request.scheme])).toEqual([
      ["desktop", 1280, "light"],
      ["desktop", 1280, "dark"],
      ["mobile", 390, "light"],
      ["mobile", 390, "dark"],
    ]);
    expect(snapshotFileName("welcome", "no-tracking", "mobile", "dark")).toBe(
      "welcome-no-tracking-mobile-dark.png",
    );
    expect(await readFile(join(outDir, "welcome-no-tracking-mobile-dark.png"), "utf8")).toBe("png");
  });

  it("falls through unavailable launchers and names every reason when none runs", async () => {
    const unavailable = (name: string): Launcher => ({
      name,
      capture: async () => ({ status: "unavailable", reason: `${name} missing` }),
    });
    const outDir = await scratch();
    const input = {
      html: "<html></html>",
      template: "welcome",
      fixture: "default",
      outDir,
      viewports: ["desktop"] as const,
      schemes: ["light"] as const,
    };
    expect(
      await takeSnapshots({
        ...input,
        launchers: [unavailable("Playwright"), unavailable("Chrome")],
      }),
    ).toEqual({ ok: false, reasons: ["Playwright: Playwright missing", "Chrome: Chrome missing"] });
    const second: Launcher = { name: "Chrome", capture: async () => ({ status: "done" }) };
    expect(
      await takeSnapshots({ ...input, launchers: [unavailable("Playwright"), second] }),
    ).toMatchObject({ ok: true, browser: "Chrome" });
  });
});

describe("Chrome launcher", () => {
  it("measures the page, then screenshots at the full height in the requested scheme", async () => {
    const outDir = await scratch();
    const htmlPath = join(outDir, "page.html");
    await writeFile(htmlPath, "<html><body></body></html>");
    const calls: string[][] = [];
    const launcher = chromeLauncher("/bin/chrome", async (_command, args, _until) => {
      calls.push([...args]);
      const screenshot = args.find((arg) => arg.startsWith("--screenshot="));
      if (screenshot !== undefined)
        await writeFile(screenshot.slice("--screenshot=".length), "png");
      return {
        code: 0,
        stdout: args.includes("--dump-dom") ? '<html data-samva-height="2400">' : "",
        stderr: "",
      };
    });
    const outFile = join(outDir, "shot.png");
    const outcome = await launcher.capture([
      { htmlPath, viewport: "mobile", width: 390, height: 844, scheme: "dark", outFile },
    ]);
    expect(outcome).toEqual({ status: "done" });
    expect(calls[1]).toContain("--window-size=390,2400");
    expect(calls[1]).toContain("--blink-settings=preferredColorScheme=1");
  });

  it("replaces the image a previous run left, and keeps it when the capture fails", async () => {
    const outDir = await scratch();
    const htmlPath = join(outDir, "page.html");
    await writeFile(htmlPath, "<html><body></body></html>");
    const outFile = join(outDir, "shot.png");
    await writeFile(outFile, "previous");
    const request = {
      htmlPath,
      viewport: "desktop",
      width: 1280,
      height: 800,
      scheme: "light",
      outFile,
    } as const;
    const chrome = (writes: boolean) =>
      chromeLauncher("/bin/chrome", async (_command, args) => {
        const screenshot = args.find((arg) => arg.startsWith("--screenshot="));
        if (screenshot !== undefined && writes)
          await writeFile(screenshot.slice("--screenshot=".length), "current");
        return { code: 0, stdout: '<html data-samva-height="900">', stderr: "" };
      });
    expect(await chrome(false).capture([request])).toMatchObject({ status: "unavailable" });
    expect(await readFile(outFile, "utf8")).toBe("previous");
    expect(await chrome(true).capture([request])).toEqual({ status: "done" });
    expect(await readFile(outFile, "utf8")).toBe("current");
  });

  it("reports itself unavailable without a binary", async () => {
    expect(await chromeLauncher(undefined).capture([])).toMatchObject({ status: "unavailable" });
  });

  it("finds SAMVA_CHROME before the usual locations", () => {
    expect(
      findChrome(
        { SAMVA_CHROME: "/custom/chrome" },
        () => null,
        () => true,
      ),
    ).toBe("/custom/chrome");
    expect(
      findChrome(
        {},
        () => null,
        () => false,
      ),
    ).toBeUndefined();
    expect(
      findChrome(
        {},
        (command) => (command === "chromium" ? "/usr/bin/chromium" : null),
        () => false,
      ),
    ).toBe("/usr/bin/chromium");
  });

  it("builds light and dark screenshot flags and reads the measured height", () => {
    const light = chromeScreenshotArgs({
      profile: "/p",
      width: 1280,
      height: 900,
      scheme: "light",
      outFile: "/o.png",
      url: "file:///x.html",
    });
    expect(light).toContain("--blink-settings=preferredColorScheme=0");
    expect(light).toContain("--screenshot=/o.png");
    expect(parseMeasuredHeight('<html data-samva-height="1234">')).toBe(1234);
    expect(parseMeasuredHeight("<html>")).toBeUndefined();
    expect(withMeasurement("<html><body>x</body></html>")).toContain("data-samva-height");
  });
});

describe("toolchainFailure", () => {
  it("names the install command when the project lacks the toolchain", () => {
    const message = toolchainFailure(
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@samva/vite' imported from /x",
      "Could not render welcome",
    );
    expect(message).toContain("@samva/vite is not installed");
    expect(message).toContain(TOOLCHAIN_INSTALL);
    expect(
      toolchainFailure("Error: `vite` is required for the template dev server.", "Could not start"),
    ).toContain("vite is not installed");
    expect(toolchainFailure("boom", "Could not render")).toBe("Could not render: boom");
  });
});

describe("toolchainSkew", () => {
  const action = "Could not build templates";

  it("accepts a project on the release line the CLI drives, or one that lacks the packages", () => {
    expect(
      toolchainSkew(
        { "@samva/markup": `${AUTHORING_MINOR}.0`, "@samva/vite": `${AUTHORING_MINOR}.99` },
        action,
      ),
    ).toBeUndefined();
    expect(toolchainSkew({}, action)).toBeUndefined();
  });

  it("tells a project on an older line to update its packages", () => {
    const message = toolchainSkew({ "@samva/markup": "0.1.0", "@samva/vite": "0.1.0" }, action);
    expect(message).toContain("this project has @samva/markup 0.1.0");
    expect(message).toContain(`this CLI drives ${AUTHORING_MINOR}.x`);
    expect(message).toContain(
      `npm install --save-dev @samva/markup@~${AUTHORING_MINOR}.0 @samva/vite@~${AUTHORING_MINOR}.0`,
    );
  });

  it("tells a project on a newer line to update the CLI", () => {
    const message = toolchainSkew({ "@samva/vite": "0.999.0" }, action);
    expect(message).toContain("this project has @samva/vite 0.999.0");
    expect(message).toContain("npm install -g @samva/cli@latest");
  });
});
