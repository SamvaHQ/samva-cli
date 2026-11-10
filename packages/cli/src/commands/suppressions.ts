import { SuppressionId } from "@samva/core/shared/base";
import { SUPPRESSION_TYPE_VALUES } from "@samva/core/shared/enums";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Email from "samva/effect/email";

import { CliUsageError, toCliApiError } from "../errors";
import { getClientProvider } from "../lib/client";
import { confirmDestructive } from "../lib/confirm";
import { namespaceField, namespaceFlag } from "../lib/namespace";
import { jsonFlag, objectRows, printFields, printJson, printJsonLine } from "../lib/output";
import { isJsonLinesRequested } from "../lib/runtime";

const list = Command.make("list", {
  namespace: namespaceFlag("list"),
  type: Flag.Literals("type", SUPPRESSION_TYPE_VALUES).pipe(Flag.optional),
  status: Flag.Literals("status", ["active", "expired"]).pipe(Flag.optional),
  search: Flag.String("search").pipe(Flag.withDescription("Address substring"), Flag.optional),
  limit: Flag.Int("limit").pipe(Flag.withDescription("Items per page"), Flag.optional),
  cursor: Flag.String("cursor").pipe(
    Flag.withDescription("Resume from a previous nextCursor"),
    Flag.optional,
  ),
  all: Flag.Boolean("all").pipe(
    Flag.withDescription("Traverse every page (requires --jsonl)"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List suppressed addresses and their namespace, newest first"),
  Command.withExamples([
    { command: "samva suppressions list --namespace ns_1234567890abcdef --status active --json" },
    { command: "samva suppressions list --all --jsonl" },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ namespace, type, status, search, limit, cursor, all, json }) {
      if (all && !isJsonLinesRequested())
        return yield* new CliUsageError({
          code: "all_requires_jsonl",
          message: "--all is an unbounded traversal and requires --jsonl.",
        });
      const client = yield* getClientProvider;
      const query = {
        ...namespaceField(namespace),
        type: Option.getOrUndefined(type),
        status: Option.getOrUndefined(status),
        search: Option.getOrUndefined(search),
        limit: Option.getOrUndefined(limit),
      };
      let nextCursor = Option.getOrUndefined(cursor);
      for (;;) {
        const data = yield* Email.listSuppressions({ ...query, cursor: nextCursor }).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError("Could not list suppressions", error)),
        );
        if (isJsonLinesRequested()) {
          for (const item of data.items) yield* printJsonLine(item);
        } else if (json) {
          return yield* printJson(data);
        } else {
          if (data.items.length === 0) yield* Console.log("No suppressions found.");
          for (const item of data.items) yield* printFields(objectRows(item, { explicit: true }));
          if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
        }
        if (!all || data.nextCursor === null) return;
        nextCursor = data.nextCursor;
      }
    }),
  ),
);

const remove = Command.make("remove", {
  id: Argument.String("id").pipe(
    Argument.withSchema(SuppressionId),
    Argument.withDescription("Suppression id from suppressions list"),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Preview removal without calling the API"),
    Flag.withDefault(false),
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withDescription("Confirm removal without a prompt"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Remove one suppression so its scope can send to the address again"),
  Command.withExamples([
    { command: "samva suppressions remove supp_1234567890abcdef --dry-run --json" },
    { command: "samva suppressions remove supp_1234567890abcdef --yes --json" },
  ]),
  Command.withHandler(
    Effect.fnUntraced(function* ({ id, dryRun, yes, json }) {
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "suppressions.remove", request: { id } })
          : printFields([
              ["Action", "suppressions.remove"],
              ["ID", id],
            ]);
      yield* confirmDestructive({
        yes,
        json,
        message: `Remove suppression ${id}? Sending to the address can resume in its scope.`,
        nonInteractiveMessage: "Pass --yes to remove a suppression, or --dry-run to preview it.",
      });
      const client = yield* getClientProvider;
      const data = yield* Email.removeSuppression({ id }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not remove suppression", error)),
      );
      if (json) return yield* printJson(data);
      yield* printFields(objectRows(data));
    }),
  ),
);

export const suppressionsCommand = Command.make("suppressions").pipe(
  Command.withDescription("Inspect and remove email suppressions within the caller's scope"),
  Command.withSubcommands([list, remove]),
);
