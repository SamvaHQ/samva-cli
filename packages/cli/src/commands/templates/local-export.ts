import { resolve } from "node:path";

import type { ProjectExportReceipt } from "@samva/vite/project";

import {
  brandResolverPrelude,
  OPTIONS_PRELUDE,
  runToolchain,
  type ToolchainEffect,
} from "./toolchain";

/**
 * The export runs in the project's own toolchain, like every other authoring command: it is the
 * project's pinned compiler that decides what its templates render to, not the CLI's.
 */
export const exportProject = (input: {
  readonly dir: string | undefined;
  readonly out: string;
  readonly assetBase: string | undefined;
  readonly offline?: boolean | undefined;
}): ToolchainEffect<ProjectExportReceipt> =>
  // The working directory is the project root, as for `check` and `build`: its `theme.css`
  // themes the export and its `.samva/brands` holds the brand snapshot.
  runToolchain<ProjectExportReceipt>({
    action: `Could not export templates${input.dir === undefined ? "" : ` in ${input.dir}`}`,
    options: {
      root: process.cwd(),
      out: resolve(input.out),
      ...(input.dir === undefined ? {} : { dir: resolve(input.dir) }),
      ...(input.assetBase === undefined ? {} : { assetBase: input.assetBase }),
      ...(input.offline === true ? { offline: true } : {}),
    },
    script: `import { exportProject } from "@samva/vite/project"; ${OPTIONS_PRELUDE}
${brandResolverPrelude()}
process.stdout.write(JSON.stringify(await exportProject(options)));`,
  });
