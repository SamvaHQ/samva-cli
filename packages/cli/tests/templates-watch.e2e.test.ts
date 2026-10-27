import { type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { spawnCli } from "./support/run-cli";

const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const roots: string[] = [];

const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of children) child.kill("SIGTERM");
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface WatchEnvelope {
  readonly type: "result";
  readonly command: "templates.check";
  readonly data: {
    readonly ok: boolean;
    readonly observation: number;
    readonly problems: ReadonlyArray<{ readonly phase: string; readonly code: string }>;
    readonly files?: ReadonlyArray<{
      readonly id: string;
      readonly template?: string;
      readonly channels?: ReadonlyArray<string>;
    }>;
  };
}

const waitForObservation = (
  child: ChildProcess,
  predicate: (envelope: WatchEnvelope) => boolean,
): Promise<WatchEnvelope> =>
  new Promise((done, reject) => {
    let buffered = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for template watch output"));
    }, 15_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("close", onClose);
    };
    const onClose = (code: number | null): void => {
      cleanup();
      reject(new Error(`Template watch exited before the expected observation (${code})`));
    };
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) continue;
        const envelope = JSON.parse(line) as WatchEnvelope;
        if (!predicate(envelope)) continue;
        cleanup();
        done(envelope);
        return;
      }
    };
    child.stdout?.on("data", onData);
    child.once("close", onClose);
  });

const template = (copy: string): string => `import { defineTemplate } from "@samva/markup";
import { Email } from "@samva/markup/email";
import { jsonSchema } from "@samva/markup/input-schema";
export default defineTemplate({
  id: "welcome",
  schema: jsonSchema<{ name: string }>({type: "object", properties: {name: {type: "string"}}, required: ["name"], additionalProperties: false}),
  fixtures: { default: { name: "Ada" } },
  email: { subject: () => "Welcome", body: (input) => <Email><p>${copy}, {input.name}</p></Email> },
});
`;

/**
 * Human watch mode writes one line per observation and never closes on its own,
 * so every wait is bounded and the collector keeps the lines a later wait needs.
 */
const readStdoutLines = (child: ChildProcess) => {
  const lines: Array<string> = [];
  const pending = new Set<{
    readonly predicate: (line: string) => boolean;
    readonly settle: (line: string) => void;
    readonly abandon: (cause: Error) => void;
  }>();
  let buffered = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    const parts = buffered.split("\n");
    buffered = parts.pop() ?? "";
    for (const part of parts) {
      if (part.length === 0) continue;
      lines.push(part);
      for (const waiter of pending) {
        if (!waiter.predicate(part)) continue;
        pending.delete(waiter);
        waiter.settle(part);
      }
    }
  });
  let exited: Error | undefined;
  child.once("close", (code: number | null) => {
    exited = new Error(`Template watch exited before the expected line (${code})`);
    for (const waiter of pending) {
      pending.delete(waiter);
      waiter.abandon(exited);
    }
  });

  return (what: string, predicate: (line: string) => boolean): Promise<string> =>
    new Promise((done, reject) => {
      const seen = lines.find(predicate);
      if (seen !== undefined) {
        done(seen);
        return;
      }
      // A watcher that already died reports that now; waiting out the bound would
      // report a timeout instead of the exit that caused it.
      if (exited !== undefined) {
        reject(exited);
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(waiter);
        reject(new Error(`Timed out waiting for ${what}. Watch printed: ${JSON.stringify(lines)}`));
      }, 45_000);
      const waiter = {
        predicate,
        settle: (line: string): void => {
          clearTimeout(timer);
          done(line);
        },
        abandon: (cause: Error): void => {
          clearTimeout(timer);
          reject(cause);
        },
      };
      pending.add(waiter);
    });
};

/** A project the watcher can compile: one template, one tsconfig, one fixture. */
const watchProject = async (copy: string): Promise<{ root: string; emails: string }> => {
  const root = await mkdtemp(join(CLI_ROOT, ".tmp-email-watch-"));
  roots.push(root);
  const emails = join(root, "emails");
  await mkdir(emails);
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        jsx: "react-jsx",
        jsxImportSource: "@samva/markup/email",
        skipLibCheck: true,
        module: "Preserve",
        moduleResolution: "Bundler",
        noEmit: true,
        strict: true,
        target: "ESNext",
      },
      include: ["emails/**/*.tsx"],
    }),
  );
  await writeFile(join(emails, "welcome.tsx"), template(copy));
  return { root, emails };
};

const startHumanWatch = (root: string): ChildProcess => {
  const child = spawnCli(
    ["templates", "check", "--watch", "--dir", "emails", "--tsconfig", "tsconfig.json"],
    { cwd: root, configHome: join(root, "config") },
  );
  children.add(child);
  return child;
};

describe("templates check --watch", () => {
  it("streams bounded JSONL observations, recovers, and closes on SIGINT", async () => {
    const { root, emails } = await watchProject("one");

    const child = spawnCli(
      [
        "templates",
        "check",
        "--watch",
        "--jsonl",
        "--dir",
        "emails",
        "--tsconfig",
        "tsconfig.json",
      ],
      { cwd: root, configHome: join(root, "config") },
    );
    children.add(child);

    const initial = await waitForObservation(child, (envelope) => envelope.data.observation === 1);
    expect(initial).toMatchObject({
      type: "result",
      command: "templates.check",
      data: {
        ok: true,
        files: [{ id: "emails/welcome.tsx", template: "welcome", channels: ["email"] }],
      },
    });
    expect(JSON.stringify(initial)).not.toContain("<!DOCTYPE html");

    await writeFile(join(emails, "welcome.tsx"), "export default function Broken(:) {}\n");
    const invalid = await waitForObservation(
      child,
      (envelope) =>
        envelope.data.observation > initial.data.observation &&
        envelope.data.problems.some((problem) => problem.phase === "typescript"),
    );
    expect(invalid.data.ok).toBe(false);

    await writeFile(join(emails, "welcome.tsx"), template("two"));
    const recovered = await waitForObservation(
      child,
      (envelope) => envelope.data.observation > invalid.data.observation && envelope.data.ok,
    );
    expect(recovered.data.ok).toBe(true);

    const exited = new Promise<number | null>((done) => child.once("close", done));
    child.kill("SIGINT");
    expect(await exited).toBe(130);
    children.delete(child);
  });
});

describe("templates check --watch without --jsonl", () => {
  it("reports how many templates compiled on each clean observation", async () => {
    const { root } = await watchProject("one");
    const child = startHumanWatch(root);
    const nextLine = readStdoutLines(child);

    const observation = await nextLine("a clean observation", (line) => line.startsWith("\u2713 "));

    expect(observation).toContain("1 template(s) compiled");
  });

  it("names the file and phase of the problem that broke a watched template", async () => {
    const { root, emails } = await watchProject("one");
    const child = startHumanWatch(root);
    const nextLine = readStdoutLines(child);
    await nextLine("the first clean observation", (line) => line.startsWith("\u2713 "));

    await writeFile(join(emails, "welcome.tsx"), "export default function Broken(:) {}\n");
    const failure = await nextLine("a failed observation", (line) => line.startsWith("\u2717 "));
    const problem = await nextLine("the problem detail", (line) => line.startsWith("  "));

    expect(failure).toContain("TypeScript check failed");
    expect(problem).toContain("welcome.tsx");
    expect(problem).toContain("error TS");
  });
});
