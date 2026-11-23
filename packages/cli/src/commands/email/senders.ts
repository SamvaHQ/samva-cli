import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Email from "samva/effect/email";

import { getConflictError, toCliApiError } from "../../errors";
import { getClientProvider } from "../../lib/client";
import { deriveOverride } from "../../lib/derive/curated";
import {
  namespaceField,
  namespaceFlag,
  placedAsRequested,
  placementLabel,
} from "../../lib/namespace";
import { jsonFlag, printFields, printJson, withoutSeries } from "../../lib/output";

const list = deriveOverride(
  "list",
  {
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
  },
  {
    mapInput: ({ cursor, limit, namespace }) => ({
      cursor: Option.getOrUndefined(cursor),
      limit: Option.getOrUndefined(limit),
      ...namespaceField(namespace),
    }),
    call: (request) => Email.listSenders(request),
    failure: "Could not list senders",
    paginate: {
      withCursor: (request, cursor) => ({ ...request, cursor }),
      start: (request) => request.cursor,
      mapItem: withoutSeries,
    },
    mapOutput: (data) => ({ ...data, items: data.items.map(withoutSeries) }),
    render: (data) =>
      Effect.gen(function* () {
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
            ["Sendable", sender.sendable ? "yes" : "no"],
            ["Provider", sender.providerLifecycle],
            ["Default", sender.isDefault ? "yes" : "no"],
            ["Namespace", sender.namespaceId ?? "organization"],
            ["ID", sender.id],
          ]);
          yield* Console.log("");
        }
        if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
      }),
  },
).pipe(
  Command.withDescription("List verified sender addresses"),
  Command.withExamples([
    { command: "samva email senders list" },
    { command: "samva email senders list --json" },
  ]),
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

const check = deriveOverride(
  "check",
  {
    id: Argument.String("id").pipe(Argument.withDescription("Sender id to check")),
    json: jsonFlag,
  },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => Email.checkSenderVerification(request),
    failure: "Could not check sender",
    render: (data) =>
      printFields([
        ["Email", data.email],
        ["Status", data.status],
        ["Verified at", data.verifiedAt ?? null],
      ]),
  },
).pipe(
  Command.withDescription("Check a sender's verification status"),
  Command.withExamples([
    {
      command: "samva email senders check sender_abc123",
      description: "Poll sender verification",
    },
  ]),
);

const setDefault = deriveOverride(
  "set-default",
  {
    id: Argument.String("id").pipe(Argument.withDescription("Sender id to make the default")),
    namespace: namespaceFlag("create").pipe(
      Flag.withDescription(
        "Choose the default sender for this namespace; omit for the credential scope",
      ),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Print the planned change without calling the API"),
      Flag.withDefault(false),
    ),
    json: jsonFlag,
  },
  {
    mapInput: ({ id, namespace }) => ({ id, ...namespaceField(namespace) }),
    call: (request) => Email.setDefaultSender(request),
    failure: "Could not set the default sender",
    preview: {
      data: (request) => ({ dryRun: true, action: "email.senders.set-default", ...request }),
      render: (request) =>
        Console.log(`[dry-run] Would make sender ${request.id} the default sender.`),
    },
    render: (_data, _input, request) =>
      Console.log(`Sender ${request.id} is now the default sender.`),
  },
).pipe(
  Command.withDescription("Make a verified sender the default From address for its scope"),
  Command.withExamples([
    { command: "samva email senders set-default sender_abc123 --dry-run" },
    { command: "samva email senders set-default sender_abc123" },
    { command: "samva email senders set-default sender_abc123 --namespace ns_1234567890123456" },
  ]),
);

const remove = deriveOverride(
  "remove",
  {
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
  },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => Email.removeSender(request),
    failure: "Could not remove sender",
    preview: {
      data: (request) => ({ dryRun: true, action: "email.senders.remove", id: request.id }),
      render: (request) => Console.log(`[dry-run] Would permanently remove sender ${request.id}.`),
    },
    confirmation: (request) => ({
      message: `Permanently remove sender ${request.id}?`,
      nonInteractiveMessage:
        "Permanent sender deletion requires --yes in non-interactive mode. Preview with --dry-run.",
    }),
    render: (_data, _input, request) => Console.log(`Removed sender ${request.id}.`),
  },
).pipe(
  Command.withDescription("Permanently remove a sender"),
  Command.withExamples([
    { command: "samva email senders remove sender_abc123 --dry-run" },
    { command: "samva email senders remove sender_abc123 --yes" },
  ]),
);

export const sendersCommand = Command.make("senders").pipe(
  Command.withDescription("Manage sender addresses"),
  Command.withExamples([
    { command: "samva email senders list", description: "List sender addresses" },
  ]),
  Command.withSubcommands([list, add, check, setDefault, remove]),
);
