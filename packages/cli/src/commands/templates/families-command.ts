import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Templates from "samva/effect/templates";

import { yesFlag } from "../../lib/confirm";
import { deriveOverride } from "../../lib/derive/curated";
import { namespaceField, namespaceFlag, placementLabel } from "../../lib/namespace";
import { jsonFlag, printFields } from "../../lib/output";

const idArgument = Argument.String("id").pipe(
  Argument.withDescription("Template family id (tfam_...)"),
);
const templateArgument = Argument.String("template-id").pipe(
  Argument.withDescription("Member template id (tmpl_...)"),
);

const renderFamily = (data: {
  readonly id: string;
  readonly name: string;
  readonly members: ReadonlyArray<{
    readonly channel: string;
    readonly id: string;
    readonly name: string;
    readonly status: string;
  }>;
}) =>
  Effect.gen(function* () {
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
  });

const list = deriveOverride(
  "list",
  {
    limit: Flag.Int("limit").pipe(
      Flag.withDescription("Families per page (1-100)"),
      Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
      Flag.withDefault(20),
    ),
    cursor: Flag.String("cursor").pipe(Flag.optional),
    namespace: namespaceFlag("list"),
    json: jsonFlag,
  },
  {
    mapInput: ({ limit, cursor, namespace }) => ({
      limit,
      cursor: Option.getOrUndefined(cursor),
      ...namespaceField(namespace),
    }),
    call: (request) => Templates.listFamilies(request),
    failure: "Could not list template families",
    render: (data) =>
      Effect.gen(function* () {
        for (const family of data.items)
          yield* printFields([
            ["ID", family.id],
            ["Name", family.name],
            ["Placement", placementLabel(family.namespaceId)],
            ["Members", String(family.members.length)],
          ]);
        yield* printFields([["Next cursor", data.nextCursor]]);
      }),
  },
).pipe(
  Command.withDescription(
    "List template families; members publish independently and WhatsApp members need their own registration and approval",
  ),
  Command.withExamples([{ command: "samva templates families list --json" }]),
);

const get = deriveOverride(
  "get",
  { id: idArgument, json: jsonFlag },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => Templates.getFamily(request),
    failure: "Could not get template families",
    render: (data) => renderFamily(data),
  },
).pipe(
  Command.withDescription(
    "Get template families; members publish independently and WhatsApp members need their own registration and approval",
  ),
  Command.withExamples([{ command: "samva templates families get <id> --json" }]),
);

const create = deriveOverride(
  "create",
  {
    name: Flag.String("name").pipe(Flag.withDescription("Family name")),
    namespace: namespaceFlag("create"),
    json: jsonFlag,
  },
  {
    mapInput: ({ name, namespace }) => ({ name, ...namespaceField(namespace) }),
    call: (request) => Templates.createFamily(request),
    failure: "Could not create template families",
    render: (data) => renderFamily(data),
  },
).pipe(
  Command.withDescription(
    "Create template families; members publish independently and WhatsApp members need their own registration and approval",
  ),
  Command.withExamples([
    { command: 'samva templates families create --name "Order shipped" --json' },
  ]),
);

const attach = deriveOverride(
  "attach",
  {
    id: idArgument,
    templateId: templateArgument,
    json: jsonFlag,
  },
  {
    mapInput: ({ id, templateId }) => ({ id, templateId }),
    call: (request) => Templates.attachFamilyMember(request),
    failure: "Could not attach template families",
    render: (data) => renderFamily(data),
  },
).pipe(
  Command.withDescription(
    "Attach template families; members publish independently and WhatsApp members need their own registration and approval",
  ),
  Command.withExamples([{ command: "samva templates families attach <id> <template-id> --json" }]),
);

const detach = deriveOverride(
  "detach",
  {
    id: idArgument,
    templateId: templateArgument,
    yes: yesFlag(),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    json: jsonFlag,
  },
  {
    mapInput: ({ id, templateId }) => ({ id, templateId }),
    call: (request) => Templates.detachFamilyMember(request),
    failure: "Could not detach template families",
    preview: {
      data: (request) => ({ dryRun: true, id: request.id, templateId: request.templateId }),
      render: (request) =>
        printFields([
          ["Family", request.id],
          ["Detach", request.templateId],
        ]),
    },
    confirmation: (request) => ({
      message: `Detach ${request.templateId} from ${request.id}?`,
      nonInteractiveMessage: "Detaching requires --yes outside a terminal; preview with --dry-run.",
    }),
    render: (data) => renderFamily(data),
  },
).pipe(
  Command.withDescription(
    "Detach template families; members publish independently and WhatsApp members need their own registration and approval",
  ),
  Command.withExamples([
    { command: "samva templates families detach <id> <template-id> --yes --json" },
  ]),
);

export const familiesCommand = Command.make("families").pipe(
  Command.withDescription(
    "Link one template per channel in a family; each member publishes independently",
  ),
  Command.withSubcommands([list, get, create, attach, detach]),
);
