import type { Readable } from "node:stream";

import { spawnGroup } from "@samva/local/process-containment";

const text = async (stream: Readable): Promise<string> => {
  let output = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) output += String(chunk);
  return output;
};

/** Packaging keeps its capacity until compiler and archive process groups finish shutdown. */
export const runReleaseCommand = async (
  command: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly capture?: boolean;
    readonly allowFailure?: boolean;
  } = {},
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const group = spawnGroup(command, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
  });
  let stdout = Promise.resolve("");
  let stderr = Promise.resolve("");
  if (options.capture) {
    if (group.child.stdout === null || group.child.stderr === null)
      throw new Error("Release command capture requires stdout and stderr pipes");
    stdout = text(group.child.stdout);
    stderr = text(group.child.stderr);
  }
  const [exitCode, capturedOut, capturedError] = await Promise.all([group.exited, stdout, stderr]);
  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(`Release command exited ${exitCode}: ${command.join(" ")}\n${capturedError}`);
  }
  return { exitCode, stdout: capturedOut, stderr: capturedError };
};
