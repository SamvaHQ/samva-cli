#!/usr/bin/env node

const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");

const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];

const run = (command, args) => {
  const child = spawn(command, args, { stdio: "inherit" });
  const forwarders = new Map();

  for (const signal of forwardedSignals) {
    const forward = () => child.kill(signal);
    forwarders.set(signal, forward);
    process.on(signal, forward);
  }

  child.on("error", (error) => {
    if (error.code === "ENOENT" && command === "bun") {
      console.error(
        "samva: the native executable is unavailable and Bun is not installed; reinstall @samva/cli with optional dependencies or install Bun",
      );
    } else {
      console.error(`samva: ${error.message}`);
    }
    process.exitCode = 1;
  });

  child.on("exit", (code, signal) => {
    for (const [forwardedSignal, forward] of forwarders) {
      process.removeListener(forwardedSignal, forward);
    }
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
};

const target = `${process.platform}-${process.arch}`;
const packageName = `@samva/cli-${target}`;
let nativeExecutable;

// oxlint-disable-next-line samva/no-try-catch-or-throw -- CommonJS launcher probes an optional platform package before using the Bun fallback
try {
  const manifest = require.resolve(`${packageName}/package.json`, { paths: [__dirname] });
  const candidate = join(dirname(manifest), "samva");
  if (existsSync(candidate)) nativeExecutable = candidate;
} catch {
  // npm may omit optional dependencies. The JavaScript distribution below is
  // the supported fallback rather than an installation-time failure.
}

if (nativeExecutable) {
  run(nativeExecutable, process.argv.slice(2));
} else {
  run("bun", ["--no-env-file", join(__dirname, "..", "dist", "bin.mjs"), ...process.argv.slice(2)]);
}
