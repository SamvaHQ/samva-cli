/**
 * Preloaded into every CLI process a test spawns. A test runner killed outright (SIGKILL, a crashed
 * worker) runs no teardown, and commands that retry until stopped (`mailboxes events`,
 * `extensions dev`) would otherwise outlive it, reparented and reconnecting to a fixture that is
 * gone. Exit as soon as the parent is no longer the runner that spawned this process.
 *
 * The runner passes its PID rather than this process reading `process.ppid` at startup: a runner
 * that dies before the preload runs would already have handed this process to a new parent.
 */
const runner = Number(process.env["CLI_TEST_RUNNER_PID"]);

const exitWithoutRunner = () => {
  if (process.ppid !== runner) process.exit(1);
};

exitWithoutRunner();
setInterval(exitWithoutRunner, 250).unref();
