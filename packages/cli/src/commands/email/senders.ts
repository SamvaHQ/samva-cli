import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Email from "samva/effect/email";

import { CliUsageError, getConflictError, toCliApiError } from "../../errors";
import { getClientProvider } from "../../lib/client";
import { confirmDestructive } from "../../lib/confirm";
import {
  namespaceField,
  namespaceFlag,
  placedAsRequested,
  placementLabel,
} from "../../lib/namespace";
import { jsonFlag, printFields, printJson, printJsonLine, withoutSeries } from "../../lib/output";
import { isJsonLinesRequested } from "../../lib/runtime";

const list = Command.make("list", {
  cursor: Flag.String("cursor").pipe(
    Flag.withDescription("Resume after this nextCursor from a previous page"),
    Flag.optional,
  ),
  limit: Flag.Int("limit").pipe(Flag.withDescription("Items per page"), Flag.optional),
  namespace: namespaceFlag("list"),
  all: Flag.Boolean("all").pipe(
    Flag.withDescription("Traverse every page (requires --jsonl)"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List verified sender addresses"),
  Command.withExamples([
    { command: "samva email senders list" },
    { command: "samva email senders list --json" },
  ]),
  Command.withHandler(({ cursor, limit, namespace, all, json }) =>
    Effect.gen(function* () {
      if (all && !isJsonLinesRequested())
        return yield* new CliUsageError({
          code: "all_requires_jsonl",
          message: "--all is an unbounded traversal and requires --jsonl.",
        });
      const client = yield* getClientProvider;
      const cursorValue = Option.getOrUndefined(cursor);
      const limitValue = Option.getOrUndefined(limit);
      const query = {
        cursor: cursorValue,
        limit: limitValue,
        ...namespaceField(namespace),
      };
      if (all) {
        let nextCursor = cursorValue;
        for (;;) {
          const data = yield* Email.listSenders({ ...query, cursor: nextCursor }).pipe(
            client.provide,
            Effect.mapError((error) => toCliApiError("Could not list senders", error)),
          );
          for (const item of data.items) yield* printJsonLine(withoutSeries(item));
          if (data.nextCursor === null) return;
          nextCursor = data.nextCursor;
        }
      }
      const data = yield* Email.listSenders(query).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not list senders", error)),
      );
      if (isJsonLinesRequested()) {
        for (const item of data.items) yield* printJsonLine(withoutSeries(item));
        return;
      }
      if (json) return yield* printJson({ ...data, items: data.items.map(withoutSeries) });
      if (data.items.length === 0) {
        return yield* Console.log(
          "No senders yet. Add one with `samva email senders add --email you@example.com`.",
        );
      }
      for (const sender of data.items) {
        yield* printFields([
          ["Email", sender.email],
          ["Name", sender.name],
          ["Status", sender.verificationStatus],
          ["Provider", sender.providerLifecycle],
          ["Default", sender.isDefault ? "yes" : "no"],
          ["Namespace", sender.namespaceId ?? "organization"],
          ["ID", sender.id],
        ]);
        yield* Console.log("");
      }
      if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const add = Command.make("add", {
  email: Flag.String("email").pipe(Flag.withDescription("Sender email address")),
  name: Flag.String("name").pipe(
    Flag.withDescription("Display name for the sender"),
    Flag.optional,
  ),
  namespace: namespaceFlag("create"),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Print the planned change without calling the API"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Add a sender address"),
  Command.withExamples([
    {
      command: "samva email senders add --email hello@example.com --dry-run",
      description: "Preview add",
    },
    {
      command: "samva email senders add --email hello@example.com",
      description: "Apply sender add",
    },
  ]),
  Command.withHandler(({ email, name, namespace, dryRun, json }) =>
    Effect.gen(function* () {
      const nameValue = Option.getOrUndefined(name);
      if (dryRun) {
        if (json)
          return yield* printJson({
            dryRun: true,
            action: "email.senders.add",
            email,
            name: nameValue,
            ...namespaceField(namespace),
          });
        return yield* Console.log(`[dry-run] Would add sender "${email}".`);
      }

      const client = yield* getClientProvider;
      yield* Effect.matchEffect(
        Email.addSender({
          email,
          ...(nameValue === undefined ? {} : { name: nameValue }),
          ...namespaceField(namespace),
        }).pipe(client.provide),
        {
          onFailure: (error) => {
            const conflict = getConflictError(error);
            if (!conflict) {
              return Effect.fail(toCliApiError("Could not add sender", error));
            }

            return Effect.gen(function* () {
              let cursor: string | undefined;
              while (true) {
                const listed = yield* Email.listSenders({ cursor, limit: 100 }).pipe(
                  client.provide,
                  Effect.mapError((listError) =>
                    toCliApiError(
                      "Sender may already exist but could not verify idempotently",
                      listError,
                    ),
                  ),
                );
                const existing =
                  (conflict.id
                    ? listed.items.find((item) => item.id === conflict.id)
                    : undefined) ?? listed.items.find((item) => item.email === email);
                if (existing) {
                  // Only the resource this request would have created is an idempotent success.
                  if (!placedAsRequested(namespace, existing.namespaceId))
                    return yield* toCliApiError(
                      `Sender "${existing.email}" already exists at ${placementLabel(existing.namespaceId)}; move its domain, or the sender, with \`samva namespaces assign\``,
                      error,
                    );
                  if (json) yield* printJson({ ...existing, idempotent: true });
                  else {
                    yield* printFields([
                      ["Email", existing.email],
                      ["Status", existing.verificationStatus],
                      ["ID", existing.id],
                    ]);
                    yield* Effect.logWarning("\nSender already exists.");
                  }
                  return;
                }
                if (listed.nextCursor === null) break;
                cursor = listed.nextCursor;
              }
              return yield* toCliApiError("Could not add sender", error);
            });
          },
          onSuccess: (data) =>
            Effect.gen(function* () {
              if (json) return yield* printJson(data);
              yield* printFields([
                ["Email", data.email],
                ["Status", data.status],
                ["Provider", data.providerLifecycle],
                ["ID", data.id],
              ]);
              yield* Effect.logInfo(`\nVerify:  samva email senders check ${data.id}`);
            }),
        },
      );
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const check = Command.make("check", {
  id: Argument.String("id").pipe(Argument.withDescription("Sender id to check")),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Check a sender's verification status"),
  Command.withExamples([
    {
      command: "samva email senders check sender_abc123",
      description: "Poll sender verification",
    },
  ]),
  Command.withHandler(({ id, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Email.checkSenderVerification({ id }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not check sender", error)),
      );
      if (json) return yield* printJson(data);
      yield* printFields([
        ["Email", data.email],
        ["Status", data.status],
        ["Verified at", data.verifiedAt ?? null],
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const setDefault = Command.make("set-default", {
  id: Argument.String("id").pipe(Argument.withDescription("Sender id to make the default")),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Print the planned change without calling the API"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Make a verified sender the organization's default From address"),
  Command.withExamples([
    { command: "samva email senders set-default sender_abc123 --dry-run" },
    { command: "samva email senders set-default sender_abc123" },
  ]),
  Command.withHandler(({ id, dryRun, json }) =>
    Effect.gen(function* () {
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "email.senders.set-default", id })
          : Console.log(`[dry-run] Would make sender ${id} the default sender.`);
      const client = yield* getClientProvider;
      const data = yield* Email.setDefaultSender({ id }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not set the default sender", error)),
      );
      if (json) return yield* printJson(data);
      yield* Console.log(`Sender ${id} is now the default sender.`);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const remove = Command.make("remove", {
  id: Argument.String("id").pipe(Argument.withDescription("Sender id to permanently remove")),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Print the deletion plan without calling the API"),
    Flag.withDefault(false),
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withDescription("Confirm permanent deletion (required for non-interactive use)"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Permanently remove a sender"),
  Command.withExamples([
    { command: "samva email senders remove sender_abc123 --dry-run" },
    { command: "samva email senders remove sender_abc123 --yes" },
  ]),
  Command.withHandler(({ id, dryRun, yes, json }) =>
    Effect.gen(function* () {
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "email.senders.remove", id })
          : Console.log(`[dry-run] Would permanently remove sender ${id}.`);
      yield* confirmDestructive({
        yes,
        json,
        message: `Permanently remove sender ${id}?`,
        nonInteractiveMessage:
          "Permanent sender deletion requires --yes in non-interactive mode. Preview with --dry-run.",
      });
      const client = yield* getClientProvider;
      const data = yield* Email.removeSender({ id }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not remove sender", error)),
      );
      if (json) return yield* printJson(data);
      yield* Console.log(`Removed sender ${id}.`);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

export const sendersCommand = Command.make("senders").pipe(
  Command.withDescription("Manage sender addresses"),
  Command.withExamples([
    { command: "samva email senders list", description: "List sender addresses" },
  ]),
  Command.withSubcommands([list, add, check, setDefault, remove]),
);
