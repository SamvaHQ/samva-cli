#!/usr/bin/env bun
import PackageJson from "@samva/cli/package.json" with { type: "json" };

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
  console.log(`samva v${PackageJson.version}`);
} else {
  const [{ cli }, { runCli }] = await Promise.all([import("./cli"), import("./run")]);
  runCli(cli);
}
