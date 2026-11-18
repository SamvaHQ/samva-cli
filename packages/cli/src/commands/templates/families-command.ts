import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Templates from "samva/effect/templates";

import { toCliApiError } from "../../errors";
import { getClientProvider } from "../../lib/client";
import { confirmDestructive } from "../../lib/confirm";
import { namespaceField, namespaceFlag, placementLabel } from "../../lib/namespace";
import { jsonFlag, printFields, printJson } from "../../lib/output";

const idArgument = Argument.String("id").pipe(
  Argument.withDescription("Template family id (tfam_...)"),
);
const templateArgument = Argument.String("template-id").pipe(
  Argument.withDescription("Member template id (tmpl_...)"),
);
const list = Command.make("list", {
  limit: Flag.Int("limit").pipe(
    Flag.withDescription("Families per page (1-100)"),
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
    Flag.withDefault(20),
  ),
  cursor: Flag.String("cursor").pipe(Flag.optional),
  namespace: namespaceFlag("list"),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "List template families; members publish independently and WhatsApp members need their own registration and approval",
  ),
  Command.withExamples([{ command: "samva templates families list --json" }]),
  Command.withHandler(({ limit, cursor, namespace, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Templates.listFamilies({
        limit,
        cursor: Option.getOrUndefined(cursor),
        ...namespaceField(namespace),
      }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not list template families", error)),
      );
      if (json) return yield* printJson(data);
      for (const family of data.items)
        yield* printFields([
          ["ID", family.id],
          ["Name", family.name],
          ["Placement", placementLabel(family.namespaceId)],
          ["Members", String(family.members.length)],
        ]);
      yield* printFields([["Next cursor", data.nextCursor]]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
const get = Command.make("get", { id: idArgument, json: jsonFlag }).pipe(
  Command.withDescription(
    "Get template families; members publish independently and WhatsApp members need their own registration and approval",
  ),
  Command.withExamples([{ command: "samva templates families get <id> --json" }]),
  Command.withHandler(({ id, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Templates.getFamily({ id }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not get template families", error)),
      );
      if (json) return yield* printJson(data);
      yield* printFields([
        ["ID", data.id],
        ["Name", data.name],
        ["Members", String(data.members.length)],
      ]);
      for (const member of data.members)
        yield* printFields([
          ["Channel", member.channel],
          ["Template", member.id],
          ["Name", member.name],
          ["Status", member.status],
        ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
const create = Command.make("create", {
  name: Flag.String("name").pipe(Flag.withDescription("Family name")),
  namespace: namespaceFlag("create"),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Create template families; members publish independently and WhatsApp members need their own registration and approval",
  ),
  Command.withExamples([
    { command: 'samva templates families create --name "Order shipped" --json' },
  ]),
  Command.withHandler(({ name, namespace, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Templates.createFamily({ name, ...namespaceField(namespace) }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not create template families", error)),
      );
      if (json) return yield* printJson(data);
      yield* printFields([
        ["ID", data.id],
        ["Name", data.name],
        ["Members", String(data.members.length)],
      ]);
      for (const member of data.members)
        yield* printFields([
          ["Channel", member.channel],
          ["Template", member.id],
          ["Name", member.name],
          ["Status", member.status],
        ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
const attach = Command.make("attach", {
  id: idArgument,
  templateId: templateArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Attach template families; members publish independently and WhatsApp members need their own registration and approval",
  ),
  Command.withExamples([{ command: "samva templates families attach <id> <template-id> --json" }]),
  Command.withHandler(({ id, templateId, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Templates.attachFamilyMember({ id, templateId }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not attach template families", error)),
      );
      if (json) return yield* printJson(data);
      yield* printFields([
        ["ID", data.id],
        ["Name", data.name],
        ["Members", String(data.members.length)],
      ]);
      for (const member of data.members)
        yield* printFields([
          ["Channel", member.channel],
          ["Template", member.id],
          ["Name", member.name],
          ["Status", member.status],
        ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
const detach = Command.make("detach", {
  id: idArgument,
  templateId: templateArgument,
  yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Detach template families; members publish independently and WhatsApp members need their own registration and approval",
  ),
  Command.withExamples([
    { command: "samva templates families detach <id> <template-id> --yes --json" },
  ]),
  Command.withHandler(({ id, templateId, yes, dryRun, json }) =>
    Effect.gen(function* () {
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, id, templateId })
          : printFields([
              ["Family", id],
              ["Detach", templateId],
            ]);
      yield* confirmDestructive({
        yes,
        json,
        message: `Detach ${templateId} from ${id}?`,
        nonInteractiveMessage:
          "Detaching requires --yes outside a terminal; preview with --dry-run.",
      });
      const client = yield* getClientProvider;
      const data = yield* Templates.detachFamilyMember({ id, templateId }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not detach template families", error)),
      );
      if (json) return yield* printJson(data);
      yield* printFields([
        ["ID", data.id],
        ["Name", data.name],
        ["Members", String(data.members.length)],
      ]);
      for (const member of data.members)
        yield* printFields([
          ["Channel", member.channel],
          ["Template", member.id],
          ["Name", member.name],
          ["Status", member.status],
        ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
export const familiesCommand = Command.make("families").pipe(
  Command.withDescription(
    "Link one template per channel in a family; each member publishes independently",
  ),
  Command.withSubcommands([list, get, create, attach, detach]),
);
