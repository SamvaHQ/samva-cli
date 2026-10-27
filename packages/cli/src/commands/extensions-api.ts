import {
  ExtensionPermission,
  ExtensionUpgradeGrant,
  ExtensionVersionString,
} from "@samva/core/mailboxes/extension";
import { mailboxSendModes } from "@samva/core/mailboxes/mailbox";
import {
  ExtensionInstallationId,
  ExtensionVersionId,
  MailboxId,
  NamespaceId,
} from "@samva/core/shared/base";
import { Cursor } from "@samva/core/shared/cursor";
import { Console, Effect, Option, Redacted, Schema } from "effect";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as ExtensionInstallations from "samva/effect/extension-installations";
import * as Extensions from "samva/effect/extensions";

import { CliUsageError } from "../errors";
import { getClientProvider } from "../lib/client";
import { confirmDestructive } from "../lib/confirm";
import { mailboxApiError } from "../lib/mailbox-errors";
import { jsonFlag, printFields, printJson, printJsonLine } from "../lib/output";
import { isJsonLinesRequested } from "../lib/runtime";
import {
  printExtension,
  printInstallation,
  printInstallationSummary,
  printRunSummary,
  printUpgrade,
  printVersion,
  printVersionSummary,
} from "./extensions-output";

const pageFlags = {
  limit: Flag.Int("limit").pipe(Flag.withDescription("Items per page"), Flag.optional),
  cursor: Flag.String("cursor").pipe(
    Flag.withDescription("Resume after this nextCursor from a previous page"),
    Flag.optional,
  ),
  all: Flag.Boolean("all").pipe(
    Flag.withDescription("Traverse every page (requires --jsonl)"),
    Flag.withDefault(false),
  ),
};

/**
 * Read one page, or every page with `--all`, and print it: a page as JSON, each item as a JSON
 * line, or each item as fields followed by the next cursor.
 */
const listPages = <Item, E, R>(input: {
  readonly flags: {
    readonly limit: Option.Option<number>;
    readonly cursor: Option.Option<string>;
    readonly all: boolean;
    readonly json: boolean;
  };
  readonly empty: string;
  readonly fetch: (query: {
    readonly limit?: number | undefined;
    readonly cursor?: string | undefined;
  }) => Effect.Effect<
    { readonly items: ReadonlyArray<Item>; readonly nextCursor: string | null },
    E,
    R
  >;
  readonly print: (item: Item) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const { limit, cursor, all, json } = input.flags;
    if (all && !isJsonLinesRequested())
      return yield* new CliUsageError({
        code: "all_requires_jsonl",
        message: "--all is an unbounded traversal and requires --jsonl.",
      });
    let next = Option.getOrUndefined(cursor);
    if (next !== undefined)
      yield* Schema.decodeEffect(Cursor)(next).pipe(
        Effect.mapError(
          () =>
            new CliUsageError({
              code: "extension_cursor_invalid",
              message: "--cursor is not a nextCursor this command printed.",
            }),
        ),
      );
    const seen = new Set<string>();
    for (;;) {
      const data = yield* input.fetch({
        limit: Option.getOrUndefined(limit),
        cursor: next,
      });
      if (isJsonLinesRequested()) {
        for (const item of data.items) yield* printJsonLine(item);
      } else if (json) yield* printJson(data);
      else {
        if (!data.items.length) yield* Console.log(input.empty);
        for (const item of data.items) yield* input.print(item);
        if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
      }
      if (!all || data.nextCursor === null || data.items.length === 0) return;
      if (seen.has(data.nextCursor))
        return yield* new CliUsageError({
          code: "extension_cursor_repeated",
          message: "The API repeated a pagination cursor; traversal stopped.",
        });
      seen.add(data.nextCursor);
      next = data.nextCursor;
    }
  });

const installationArgument = Argument.String("installation-id").pipe(
  Argument.withSchema(ExtensionInstallationId),
);
const extensionArgument = Argument.String("extension");
const list = Command.make("list", { ...pageFlags, json: jsonFlag }).pipe(
  Command.withDescription("List published extensions, newest first"),
  Command.withExamples([
    { command: "samva extensions list --json" },
    { command: "samva extensions list --all --jsonl" },
  ]),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      yield* listPages({
        flags,
        empty: "No extensions found.",
        fetch: (query) =>
          Extensions.list(query).pipe(
            client.provide,
            Effect.mapError((e) => mailboxApiError("Could not list extensions", e)),
          ),
        print: printExtension,
      });
    }),
  ),
);
const versions = Command.make("versions", {
  extension: extensionArgument,
  ...pageFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List an extension's published versions, newest first"),
  Command.withExamples([{ command: "samva extensions versions auto-reply --json" }]),
  Command.withHandler(({ extension, ...flags }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      yield* listPages({
        flags,
        empty: "No versions found.",
        fetch: (query) =>
          Extensions.listVersions({ id: extension, ...query }).pipe(
            client.provide,
            Effect.mapError((e) => mailboxApiError("Could not list versions", e)),
          ),
        print: printVersionSummary,
      });
    }),
  ),
);
const version = Command.make("version", {
  extension: extensionArgument,
  version: Argument.String("version"),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show one published version with its manifest, by version or id"),
  Command.withExamples([{ command: "samva extensions version auto-reply 1.0.0 --json" }]),
  Command.withHandler(({ extension, version: selectedVersion, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Extensions.getVersion({ id: extension, versionId: selectedVersion }).pipe(
        client.provide,
        Effect.mapError((e) => mailboxApiError("Could not read version", e)),
      );
      if (json) return yield* printJson(data);
      yield* printVersion(data);
    }),
  ),
);
const install = Command.make("install", {
  extension: extensionArgument,
  version: Flag.String("version").pipe(Flag.withSchema(ExtensionVersionString), Flag.optional),
  mailbox: Flag.String("mailbox").pipe(Flag.withSchema(MailboxId), Flag.atLeast(0)),
  namespace: Flag.String("namespace").pipe(Flag.withSchema(NamespaceId), Flag.optional),
  permission: Flag.Literals("permission", ExtensionPermission.literals).pipe(Flag.atLeast(0)),
  sendMode: Flag.Literals("send-mode", mailboxSendModes).pipe(Flag.optional),
  webhookUrl: Flag.String("webhook-url").pipe(Flag.optional),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Install a published extension using a person signed in with samva login",
  ),
  Command.withExamples([
    {
      command:
        "samva extensions install auto-reply --mailbox mbx_1234567890123456 --permission read --permission send --send-mode approval",
    },
  ]),
  Command.withHandler(
    ({
      extension,
      version: selectedVersion,
      mailbox,
      namespace,
      permission,
      sendMode,
      webhookUrl,
      json,
    }) =>
      Effect.gen(function* () {
        const client = yield* getClientProvider;
        const data = yield* ExtensionInstallations.install({
          extension,
          ...(Option.isSome(selectedVersion) ? { version: selectedVersion.value } : {}),
          ...(mailbox.length ? { mailboxIds: mailbox } : {}),
          ...(Option.isSome(namespace) ? { namespaceId: namespace.value } : {}),
          ...(permission.length ? { permissions: permission } : {}),
          ...(Option.isSome(sendMode) ? { sendMode: sendMode.value } : {}),
          ...(Option.isSome(webhookUrl) ? { webhookUrl: webhookUrl.value } : {}),
        }).pipe(
          client.provide,
          Effect.mapError((e) =>
            mailboxApiError("Could not install extension", e, { personOnly: "install" }),
          ),
        );
        // The credentials are shown once, on purpose: this is where they leave their wrapper.
        const credentials =
          data.credentials === null
            ? null
            : {
                apiKey: Redacted.value(data.credentials.apiKey),
                webhookSecret: Redacted.value(data.credentials.webhookSecret),
              };
        if (json) return yield* printJson({ ...data, credentials });
        yield* printInstallation(data.installation);
        if (credentials) {
          yield* Console.log("Store these now; they are not shown again.");
          yield* printFields([
            ["API key", credentials.apiKey],
            ["Webhook secret", credentials.webhookSecret],
          ]);
        }
      }),
  ),
);
const installations = Command.make("installations", { ...pageFlags, json: jsonFlag }).pipe(
  Command.withDescription("List extension installations, newest first"),
  Command.withExamples([{ command: "samva extensions installations --json" }]),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      yield* listPages({
        flags,
        empty: "No installations found.",
        fetch: (query) =>
          ExtensionInstallations.list(query).pipe(
            client.provide,
            Effect.mapError((e) => mailboxApiError("Could not list installations", e)),
          ),
        print: printInstallationSummary,
      });
    }),
  ),
);
const installation = Command.make("installation", {
  id: installationArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show an installation's permissions, scope, send mode, and webhook"),
  Command.withExamples([{ command: "samva extensions installation exti_1234567890123456 --json" }]),
  Command.withHandler(({ id, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* ExtensionInstallations.get({ id }).pipe(
        client.provide,
        Effect.mapError((e) => mailboxApiError("Could not read installation", e)),
      );
      if (json) return yield* printJson(data);
      yield* printInstallation(data);
    }),
  ),
);
const upgrade = Command.make("upgrade", {
  id: installationArgument,
  version: Flag.String("version").pipe(
    Flag.withSchema(Schema.Union([ExtensionVersionString, ExtensionVersionId])),
    Flag.withDescription(
      "Published version or version ID; defaults to the latest published version",
    ),
    Flag.optional,
  ),
  acceptPermissions: Flag.Literals("accept-permissions", ExtensionUpgradeGrant.literals).pipe(
    Flag.withDescription(
      "Acknowledge one added permission:<name> or event:<type> grant; repeat for each",
    ),
    Flag.atLeast(0),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Ask the API for a preview without changing the installation"),
    Flag.withDefault(false),
  ),
  yes: Flag.Boolean("yes").pipe(Flag.withDescription("Skip confirmation"), Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Upgrade an installation using a person signed in with samva login"),
  Command.withExamples([
    { command: "samva extensions upgrade exti_1234567890123456 --dry-run --json" },
    {
      command:
        "samva extensions upgrade exti_1234567890123456 --version 2.0.0 --accept-permissions permission:send --accept-permissions event:mailbox.message.sent --yes",
    },
  ]),
  Command.withHandler(({ id, version: selectedVersion, acceptPermissions, dryRun, yes, json }) =>
    Effect.gen(function* () {
      if (!dryRun)
        yield* confirmDestructive({
          yes,
          json,
          message: `Upgrade ${id} to ${Option.getOrElse(selectedVersion, () => "the latest published version")}?`,
          nonInteractiveMessage:
            "Upgrade changes the installation's version and grants. Preview with --dry-run, then pass --yes to confirm and --accept-permissions for every added grant.",
        });
      const client = yield* getClientProvider;
      const data = yield* ExtensionInstallations.upgrade({
        id,
        ...(Option.isSome(selectedVersion) ? { version: selectedVersion.value } : {}),
        ...(acceptPermissions.length ? { acceptPermissions } : {}),
        ...(dryRun ? { dryRun: true } : {}),
      }).pipe(
        client.provide,
        Effect.mapError((e) =>
          mailboxApiError("Could not upgrade extension", e, { personOnly: "manage" }),
        ),
      );
      if (json) return yield* printJson(data);
      yield* printUpgrade(data);
    }),
  ),
);
const uninstall = Command.make("uninstall", {
  id: installationArgument,
  yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Delete an installation and revoke its credentials; --yes skips confirmation",
  ),
  Command.withExamples([
    { command: "samva extensions uninstall exti_1234567890123456 --yes --json" },
  ]),
  Command.withHandler(({ id, yes, json }) =>
    Effect.gen(function* () {
      yield* confirmDestructive({
        yes,
        json,
        message: `Uninstall ${id} and revoke its credentials?`,
        nonInteractiveMessage:
          "Uninstall revokes the installation's credentials. Pass --yes to confirm.",
      });
      const client = yield* getClientProvider;
      const data = yield* ExtensionInstallations.uninstall({ id }).pipe(
        client.provide,
        Effect.mapError((e) =>
          mailboxApiError("Could not uninstall extension", e, { personOnly: "manage" }),
        ),
      );
      if (json) return yield* printJson(data);
      yield* Console.log(`Uninstalled ${id}.`);
    }),
  ),
);
const setStatus = (name: "disable" | "enable") =>
  Command.make(name, { id: installationArgument, json: jsonFlag }).pipe(
    Command.withDescription(
      `${name === "disable" ? "Disable" : "Enable"} an extension installation`,
    ),
    Command.withExamples([{ command: `samva extensions ${name} exti_1234567890123456 --json` }]),
    Command.withHandler(({ id, json }) =>
      Effect.gen(function* () {
        const client = yield* getClientProvider;
        const operation =
          name === "disable" ? ExtensionInstallations.disable : ExtensionInstallations.enable;
        const data = yield* operation({ id }).pipe(
          client.provide,
          Effect.mapError((e) =>
            mailboxApiError(`Could not ${name} installation`, e, { personOnly: "manage" }),
          ),
        );
        if (json) return yield* printJson(data);
        yield* printInstallation(data);
      }),
    ),
  );
const runs = Command.make("runs", { id: installationArgument, json: jsonFlag }).pipe(
  Command.withDescription("List a hosted installation's retained runs and their outcomes"),
  Command.withExamples([{ command: "samva extensions runs exti_1234567890123456 --json" }]),
  Command.withHandler(({ id, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* ExtensionInstallations.listRuns({ id }).pipe(
        client.provide,
        Effect.mapError((e) => mailboxApiError("Could not list runs", e)),
      );
      if (json) return yield* printJson(data);
      if (!data.items.length) return yield* Console.log("No runs found.");
      for (const item of data.items) yield* printRunSummary(item);
    }),
  ),
);
const run = Command.make("run", {
  id: installationArgument,
  run: Argument.String("run-id"),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show one hosted run with the lines its handler logged"),
  Command.withExamples([
    { command: "samva extensions run exti_1234567890123456 0b6c1e1a-run-id --json" },
  ]),
  Command.withHandler(({ id, run: runId, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* ExtensionInstallations.getRun({ id, runId }).pipe(
        client.provide,
        Effect.mapError((e) => mailboxApiError("Could not read run", e)),
      );
      if (json) return yield* printJson(data);
      yield* printRunSummary(data);
      yield* Console.log("Logs");
      yield* Console.log(data.logs.length ? data.logs.join("\n") : "None");
    }),
  ),
);
export const extensionApiCommands = [
  list,
  versions,
  version,
  install,
  installations,
  installation,
  upgrade,
  uninstall,
  setStatus("disable"),
  setStatus("enable"),
  runs,
  run,
];
