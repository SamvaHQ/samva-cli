import { resolve } from "node:path";

import type { BuildTemplatesResult } from "@samva/vite/build";

import {
  brandResolverPrelude,
  OPTIONS_PRELUDE,
  runToolchain,
  type ToolchainEffect,
} from "./toolchain";

/**
 * Build every template through the project-installed `@samva/vite`. An unset `dir` builds
 * `templates/` and `emails/`, whichever exist, as `@samva/vite` does.
 */
export const buildDir = (
  dir: string | undefined,
  assetBase: string | undefined,
): ToolchainEffect<BuildTemplatesResult> =>
  runToolchain<BuildTemplatesResult>({
    action: `Could not build templates${dir === undefined ? "" : ` in ${dir}`}`,
    options: {
      root: process.cwd(),
      ...(dir === undefined ? {} : { dir: resolve(dir) }),
      ...(assetBase === undefined ? {} : { assetBase }),
    },
    script: `import { buildTemplates } from "@samva/vite/build"; ${OPTIONS_PRELUDE}
${brandResolverPrelude()} process.stdout.write(JSON.stringify(await buildTemplates(options)));`,
  });
