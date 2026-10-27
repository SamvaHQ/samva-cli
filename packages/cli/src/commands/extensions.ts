import { resolve } from "node:path";

import {
  ExtensionManifest,
  ExtensionName,
  ExtensionRuntime,
} from "@samva/core/mailboxes/extension";
import { MailboxId } from "@samva/core/shared/base";
import { createSamvaClient, dispatchEvent } from "@samva/mailbox";
import { Console, Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import * as Extensions from "samva/effect/extensions";

import { CliUsageError, SamvaCliError } from "../errors";
import { getClientConfig, getClientProvider, requestAuthHeaders } from "../lib/client";
import { buildExtension, initExtension, loadExtension } from "../lib/extension-project";
import { mailboxApiError } from "../lib/mailbox-errors";
import { jsonFlag, printFields, printJson, resultEnvelope, writeOutput } from "../lib/output";
import { outputModeFromArgv } from "../lib/runtime";
import { extensionApiCommands } from "./extensions-api";
import { printExtension, printManifest, printVersion } from "./extensions-output";
import { tailEvents } from "./mailboxes-events";

const directory = Argument.String("dir").pipe(Argument.withDefault("."));
const entryFlag = Flag.String("entry").pipe(Flag.withDefault("src/extension.ts"));
const projectFlags = { dir: directory, entry: entryFlag, json: jsonFlag };
const init = Command.make("init", {
  dir: directory,
  name: Flag.String("name").pipe(Flag.withSchema(ExtensionName)),
  runtime: Flag.Literals("runtime", ExtensionRuntime.literals).pipe(
    Flag.withDefault("hosted" as const),
  ),
  displayName: Flag.String("display-name").pipe(Flag.optional),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create a mailbox extension project in an empty directory"),
  Command.withExamples([{ command: "samva extensions init ./acknowledge --name acknowledge" }]),
  Command.withHandler(({ dir, name, runtime, displayName, json }) =>
    Effect.gen(function* () {
      const manifest = yield* Schema.decodeEffect(ExtensionManifest)({
        name,
        displayName: Option.getOrElse(displayName, () => name),
        version: "0.1.0",
        runtime,
        events: ["mailbox.message.received"],
        permissions: ["read", "send"],
      });
      const data = yield* initExtension(dir, manifest);
      if (json) yield* printJson(data);
      else {
        yield* Console.log(`Created ${name} in ${data.directory}.`);
        yield* printManifest(data.manifest);
        yield* printFields([["Files", data.files.join(", ")]]);
        yield* Console.log("Run bun install in that directory, then samva extensions dev.");
      }
    }),
  ),
);
const build = Command.make("build", {
  ...projectFlags,
  out: Flag.String("out").pipe(Flag.withDefault("dist/extension.js")),
}).pipe(
  Command.withDescription("Bundle and validate one self-contained extension ES module"),
  Command.withExamples([{ command: "samva extensions build . --out dist/extension.js" }]),
  Command.withHandler(({ dir, entry, out, json }) =>
    Effect.gen(function* () {
      const { bundle: _bundle, ...data } = yield* buildExtension(dir, entry, out);
      if (json) yield* printJson(data);
      else {
        yield* printManifest(data.manifest);
        yield* printFields([
          ["Size", `${data.sizeBytes} bytes`],
          ["SHA256", data.sha256],
          ["Output", data.output],
        ]);
      }
    }),
  ),
);
const publish = Command.make("publish", projectFlags).pipe(
  Command.withDescription(
    "Build and publish an immutable extension version as a person signed in with samva login",
  ),
  Command.withExamples([{ command: "samva extensions publish . --json" }]),
  Command.withHandler(({ dir, entry, json }) =>
    Effect.gen(function* () {
      const built = yield* buildExtension(dir, entry);
      const client = yield* getClientProvider;
      const data = yield* Extensions.publish({
        manifest: built.manifest,
        ...(built.manifest.runtime === "hosted" ? { bundle: built.bundle } : {}),
      }).pipe(
        client.provide,
        Effect.mapError((error) =>
          mailboxApiError("Could not publish extension", error, { personOnly: "publish" }),
        ),
      );
      if (json) yield* printJson(data);
      else {
        yield* Console.log(`Published ${data.extension.name}@${data.version.version}.`);
        yield* printExtension(data.extension);
        yield* printVersion(data.version);
      }
    }),
  ),
);
const dev = Command.make("dev", {
  ...projectFlags,
  mailbox: Flag.String("mailbox").pipe(Flag.withSchema(MailboxId), Flag.atLeast(0)),
}).pipe(
  Command.withDescription(
    "Run local handlers against mailbox events; Ctrl+C stops. With samva login, tool calls are attributed to you, not to an installation. Set SAMVA_EVENTS_URL for a local stream.",
  ),
  Command.withExamples([
    {
      command: "samva extensions dev . --mailbox mbx_1234567890123456 --jsonl",
      description: "One result envelope per handled event",
    },
  ]),
  Command.withHandler(({ dir, entry, mailbox }) =>
    Effect.gen(function* () {
      const mode = outputModeFromArgv(process.argv.slice(2));
      // --json promises one bounded result, which a tail cannot buffer without losing
      // acknowledged events on a mid-stream failure.
      if (mode === "json")
        return yield* new CliUsageError({
          code: "events_requires_jsonl",
          message:
            "extensions dev streams and cannot return one --json result. Use --jsonl to stream one result per handled event.",
        });
      const extension = yield* loadExtension(resolve(dir, entry));
      const config = yield* getClientConfig;
      const headers = requestAuthHeaders(config);
      // A handler still waiting on the API when the stream stops is cancelled, so it cannot keep
      // the process alive.
      const stopped = yield* Effect.abortSignal;
      const client = createSamvaClient({
        fetch: (input, requestInit) =>
          globalThis.fetch(input, {
            ...requestInit,
            signal:
              requestInit?.signal === undefined || requestInit.signal === null
                ? stopped
                : AbortSignal.any([requestInit.signal, stopped]),
          }),
        baseUrl: config.baseUrl,
        headers,
      });
      yield* tailEvents({
        mailboxIds: mailbox,
        output: mode,
        onEvent: (event) =>
          Effect.gen(function* () {
            if (!extension.manifest.events.some((type) => type === event.type)) return;
            const body = JSON.stringify({
              type: event.type,
              timestamp: event.timestamp,
              data: event.data,
            });
            const result = yield* Effect.tryPromise({
              try: () => dispatchEvent(extension, { eventId: event.id, attempt: 1, body }, client),
              catch: (cause) =>
                new SamvaCliError({ message: `Extension handler failed: ${String(cause)}` }),
            });
            // Quiet prints nothing; the event is still acknowledged.
            if (mode === "quiet") return;
            const data = { eventId: event.id, cursor: event.cursor, ...result };
            const text =
              mode === "jsonl"
                ? JSON.stringify(resultEnvelope("extensions.dev", data))
                : [
                    ...result.logs,
                    `${event.id}: ${result.ok ? "succeeded" : `failed: ${result.error}`}`,
                    `Cursor  ${event.cursor}`,
                  ].join("\n");
            yield* writeOutput(process.stdout, `${text}\n`);
          }),
      });
    }).pipe(Effect.scoped),
  ),
);

export const extensionsCommand = Command.make("extensions").pipe(
  Command.withDescription("Author, publish, and install mailbox extensions"),
  Command.withSubcommands([init, build, publish, dev, ...extensionApiCommands]),
);
