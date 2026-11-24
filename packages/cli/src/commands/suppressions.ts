import { SuppressionId } from "@samva/core/shared/base";
import { SUPPRESSION_TYPE_VALUES } from "@samva/core/shared/enums";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Email from "samva/effect/email";

import { yesFlag } from "../lib/confirm";
import { deriveOverride } from "../lib/derive/curated";
import { namespaceField, namespaceFlag } from "../lib/namespace";
import { jsonFlag, objectRows, printFields } from "../lib/output";

const list = deriveOverride(
  "list",
  {
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
  },
  {
    mapInput: ({ namespace, type, status, search, limit, cursor }) => ({
      ...namespaceField(namespace),
      type: Option.getOrUndefined(type),
      status: Option.getOrUndefined(status),
      search: Option.getOrUndefined(search),
      limit: Option.getOrUndefined(limit),
      cursor: Option.getOrUndefined(cursor),
    }),
    call: (request) => Email.listSuppressions(request),
    failure: "Could not list suppressions",
    paginate: {
      withCursor: (request, cursor) => ({ ...request, cursor }),
      start: (request) => request.cursor,
    },
    render: (data) =>
      Effect.gen(function* () {
        if (data.items.length === 0) yield* Console.log("No suppressions found.");
        for (const item of data.items) yield* printFields(objectRows(item, { explicit: true }));
        if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
      }),
  },
).pipe(
  Command.withDescription("List suppressed addresses and their namespace, newest first"),
  Command.withExamples([
    { command: "samva suppressions list --namespace ns_1234567890abcdef --status active --json" },
    { command: "samva suppressions list --all --jsonl" },
  ]),
);

const remove = deriveOverride(
  "remove",
  {
    id: Argument.String("id").pipe(
      Argument.withSchema(SuppressionId),
      Argument.withDescription("Suppression id from suppressions list"),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Preview removal without calling the API"),
      Flag.withDefault(false),
    ),
    yes: yesFlag("Confirm removal"),
    json: jsonFlag,
  },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => Email.removeSuppression(request),
    failure: "Could not remove suppression",
    preview: {
      data: (request) => ({ dryRun: true, action: "suppressions.remove", request }),
      render: (request) =>
        printFields([
          ["Action", "suppressions.remove"],
          ["ID", request.id],
        ]),
    },
    confirmation: (request) => ({
      message: `Remove suppression ${request.id}? Sending to the address can resume in its scope.`,
      nonInteractiveMessage: "Pass --yes to remove a suppression, or --dry-run to preview it.",
    }),
    render: (data) => printFields(objectRows(data)),
  },
).pipe(
  Command.withDescription("Remove one suppression so its scope can send to the address again"),
  Command.withExamples([
    { command: "samva suppressions remove supp_1234567890abcdef --dry-run --json" },
    { command: "samva suppressions remove supp_1234567890abcdef --yes --json" },
  ]),
);

export const suppressionsCommand = Command.make("suppressions").pipe(
  Command.withDescription("Inspect and remove email suppressions within the caller's scope"),
  Command.withSubcommands([list, remove]),
);
