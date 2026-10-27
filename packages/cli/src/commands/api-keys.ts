import { mailboxSendModes, type MailboxSendMode } from "@samva/core/mailboxes/mailbox";
import {
  API_KEY_LEVEL_RESOURCES,
  API_KEY_MAILBOX_ACTIONS,
  apiKeyAccessLevels,
  type ApiKeyLevelResource,
} from "@samva/core/organizations/api-key-access";
import { MailboxId, NamespaceId } from "@samva/core/shared/base";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as ApiKeys from "samva/effect/api-keys";

import { CliUsageError, toCliApiError } from "../errors";
import { getClientProvider } from "../lib/client";
import { confirmDestructive } from "../lib/confirm";
import { jsonFlag, printFields, printJson, printJsonLine } from "../lib/output";
import { isJsonLinesRequested } from "../lib/runtime";

/**
 * `samva api-keys` manages the organization's API keys. The API decides what a key may be given: a
 * caller cannot issue a key with more access than it holds, so the CLI adds no gate of its own
 * beyond refusing flag combinations the request cannot express. Mailbox access is
 * `--mailbox-permission` (with `--mailbox` and `--send-mode` narrowing it) and namespace scope is
 * `--namespace`; neither is a `--grant` resource.
 */

const idArgument = Argument.String("id").pipe(Argument.withDescription("API key id"));

const dryRunFlag = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Print the request without sending it"),
  Flag.withDefault(false),
);
const yesFlag = Flag.Boolean("yes").pipe(
  Flag.withDescription("Confirm without prompting (required outside a terminal)"),
  Flag.withDefault(false),
);

const GRANT_LEVELS = ["read", "write"] as const;
type GrantLevel = (typeof GRANT_LEVELS)[number];

/**
 * The resources a key can be granted: the ones the public request schema accepts. The public
 * OpenAPI document omits resources behind launch flags, so probing the schema the CLI decodes
 * against keeps help, parsing, and the request in agreement.
 */
const GRANTABLE_RESOURCES = API_KEY_LEVEL_RESOURCES.filter((resource) =>
  Option.isSome(
    Schema.decodeOption(ApiKeys.CreatePayload)(
      { name: "probe", access: { mode: "restricted", resources: { [resource]: "read" } } },
      { onExcessProperty: "error" },
    ),
  ),
);

const isLevelResource = (name: string): name is ApiKeyLevelResource =>
  GRANTABLE_RESOURCES.some((resource) => resource === name);
const isGrantLevel = (name: string): name is GrantLevel =>
  GRANT_LEVELS.some((level) => level === name);

/** `email=write` → one resource and level, refusing what the API's access levels do not offer. */
const parseGrant = (raw: string) => {
  const separator = raw.indexOf("=");
  const resource = separator < 0 ? raw : raw.slice(0, separator);
  const level = separator < 0 ? "" : raw.slice(separator + 1);
  if (resource === "mailboxes") {
    return new CliUsageError({
      code: "invalid_grant",
      message:
        "--grant does not cover mailboxes; use --mailbox-permission <action> (with optional --mailbox and --send-mode) instead.",
    });
  }
  if (!isLevelResource(resource) || !isGrantLevel(level)) {
    return new CliUsageError({
      code: "invalid_grant",
      message: `--grant must be <resource>=read|write, got "${raw}". Resources: ${GRANTABLE_RESOURCES.join(", ")}.`,
    });
  }
  if (!apiKeyAccessLevels(resource).includes(level)) {
    return new CliUsageError({
      code: "invalid_grant",
      message: `${resource} can only be granted read access.`,
    });
  }
  return { resource, level } as const;
};

interface MailboxFlags {
  readonly permissions: ReadonlyArray<(typeof API_KEY_MAILBOX_ACTIONS)[number]>;
  readonly mailboxIds: ReadonlyArray<MailboxId>;
  readonly sendMode: Option.Option<MailboxSendMode>;
}

const repeated = (values: ReadonlyArray<string>) =>
  values.find((value, index) => values.indexOf(value) !== index);

/** The key's mailbox access, or none; `--mailbox` and `--send-mode` narrow `--mailbox-permission`. */
const mailboxAccessFromFlags = (flags: MailboxFlags) =>
  Effect.gen(function* () {
    if (flags.permissions.length === 0) {
      if (flags.mailboxIds.length > 0 || Option.isSome(flags.sendMode)) {
        return yield* new CliUsageError({
          code: "mailbox_permission_required",
          message: `--mailbox and --send-mode narrow mailbox access; also pass --mailbox-permission ${API_KEY_MAILBOX_ACTIONS.join("|")}.`,
        });
      }
      return undefined;
    }
    const duplicatePermission = repeated(flags.permissions);
    if (duplicatePermission !== undefined) {
      return yield* new CliUsageError({
        code: "invalid_mailbox_access",
        message: `--mailbox-permission names ${duplicatePermission} more than once.`,
      });
    }
    const duplicateMailbox = repeated(flags.mailboxIds);
    if (duplicateMailbox !== undefined) {
      return yield* new CliUsageError({
        code: "invalid_mailbox_access",
        message: `--mailbox names ${duplicateMailbox} more than once.`,
      });
    }
    return {
      permissions: flags.permissions,
      ...(flags.mailboxIds.length > 0 ? { mailboxIds: flags.mailboxIds } : {}),
      ...(Option.isSome(flags.sendMode) ? { sendMode: flags.sendMode.value } : {}),
    };
  });

/**
 * The access one `create` asks for: `--full-access`, or a restricted key made of repeatable
 * `--grant` resources and/or `--mailbox-permission` mailbox access, optionally confined to a
 * `--namespace`.
 */
const accessFromFlags = (
  grants: ReadonlyArray<string>,
  fullAccess: boolean,
  mailbox: MailboxFlags,
  namespace: Option.Option<NamespaceId>,
) =>
  Effect.gen(function* () {
    const restrictedFlags =
      grants.length > 0 ||
      mailbox.permissions.length > 0 ||
      mailbox.mailboxIds.length > 0 ||
      Option.isSome(mailbox.sendMode) ||
      Option.isSome(namespace);
    if (fullAccess && restrictedFlags) {
      return yield* new CliUsageError({
        code: "access_conflict",
        message:
          "Pass either --full-access or restricted access (--grant, --mailbox-permission, --namespace), not both.",
      });
    }
    if (fullAccess) return { mode: "full" } as const;
    const mailboxes = yield* mailboxAccessFromFlags(mailbox);
    if (grants.length === 0 && mailboxes === undefined) {
      return yield* new CliUsageError({
        code: "access_required",
        message:
          "Choose the key's access: --full-access, or one or more --grant <resource>=read|write and/or --mailbox-permission <action>.",
      });
    }
    const resources: Partial<Record<ApiKeyLevelResource, GrantLevel>> = {};
    for (const raw of grants) {
      const grant = parseGrant(raw);
      if (grant instanceof CliUsageError) return yield* grant;
      if (resources[grant.resource] !== undefined) {
        return yield* new CliUsageError({
          code: "invalid_grant",
          message: `--grant names ${grant.resource} more than once.`,
        });
      }
      resources[grant.resource] = grant.level;
    }
    return {
      mode: "restricted",
      resources,
      ...(mailboxes === undefined ? {} : { mailboxes }),
      ...(Option.isSome(namespace) ? { namespaceId: namespace.value } : {}),
    } as const;
  });

const parseExpiresAt = (raw: string) =>
  Number.isNaN(Date.parse(raw))
    ? Effect.fail(
        new CliUsageError({
          code: "invalid_expires_at",
          message: `--expires-at must be an ISO 8601 instant such as 2027-01-01T00:00:00Z, got "${raw}".`,
        }),
      )
    : Effect.succeed(raw);

/** Decode a payload through the SDK schema so the API's validation has one source. */
const decodeRequest = <A>(schema: Schema.Codec<A, unknown>, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      (error) => new CliUsageError({ code: "invalid_api_key_request", message: error.message }),
    ),
  );

type KeyAccess = ApiKeys.CreatePayload["access"];

/** `full`, or the restricted key's grants as `resource:level` pairs. */
const describeAccess = (access: KeyAccess | undefined): string => {
  if (access === undefined || access === null) return "full";
  if (access.mode === "full") return "full";
  const grants = Object.entries(access.resources)
    .filter(([, level]) => level !== undefined)
    .map(([resource, level]) => `${resource}:${level}`);
  if (access.mailboxes !== undefined && access.mailboxes !== null) {
    const { permissions, mailboxIds, sendMode } = access.mailboxes;
    const scope = [
      ...(mailboxIds === undefined || mailboxIds === null ? [] : [mailboxIds.join("+")]),
      ...(sendMode === undefined || sendMode === "send" ? [] : [`${sendMode} sends`]),
    ];
    grants.push(
      `mailboxes:${permissions.join("+")}${scope.length === 0 ? "" : ` [${scope.join("; ")}]`}`,
    );
  }
  if (access.namespaceId !== undefined && access.namespaceId !== null)
    grants.push(`namespace:${access.namespaceId}`);
  return `restricted (${grants.length === 0 ? "no grants" : grants.join(", ")})`;
};

interface KeyRow {
  readonly id: string;
  readonly name: string;
  readonly start: string | null;
  readonly description?: string | null | undefined;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly isActive: boolean;
  readonly access: KeyAccess;
  readonly owner: { readonly name: string; readonly email: string } | null;
}

const keyFields = (key: KeyRow): ReadonlyArray<readonly [string, unknown]> => [
  ["ID", key.id],
  ["Name", key.name],
  ["Description", key.description],
  ["Prefix", key.start],
  ["Status", key.isActive ? "active" : "revoked"],
  ["Access", describeAccess(key.access)],
  ["Owner", key.owner === null ? undefined : `${key.owner.name} <${key.owner.email}>`],
  ["Created", key.createdAt],
  ["Expires", key.expiresAt],
  ["Last used", key.lastUsedAt],
];

const withJsonQuiet = <A, E, R>(json: boolean, effect: Effect.Effect<A, E, R>) =>
  json ? effect.pipe(Effect.provideService(References.MinimumLogLevel, "None")) : effect;

const list = Command.make("list", {
  status: Flag.Literals("status", ["active", "revoked"]).pipe(
    Flag.withDescription("Only keys in this state"),
    Flag.optional,
  ),
  search: Flag.String("search").pipe(
    Flag.withDescription("Match against name and description"),
    Flag.optional,
  ),
  limit: Flag.Int("limit").pipe(Flag.withDescription("Items per page"), Flag.optional),
  cursor: Flag.String("cursor").pipe(
    Flag.withDescription("Resume after this nextCursor from a previous page"),
    Flag.optional,
  ),
  all: Flag.Boolean("all").pipe(
    Flag.withDescription("Traverse every page (requires --jsonl)"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List the organization's API keys, newest first"),
  Command.withExamples([
    { command: "samva api-keys list" },
    { command: "samva api-keys list --status active --search ci --json" },
    { command: "samva api-keys list --all --jsonl" },
  ]),
  Command.withHandler(({ status, search, limit, cursor, all, json }) =>
    withJsonQuiet(
      json,
      Effect.gen(function* () {
        if (all && !isJsonLinesRequested()) {
          return yield* new CliUsageError({
            code: "all_requires_jsonl",
            message: "--all is an unbounded traversal and requires --jsonl.",
          });
        }
        const client = yield* getClientProvider;
        const query = {
          status: Option.getOrUndefined(status),
          search: Option.getOrUndefined(search),
          limit: Option.getOrUndefined(limit),
        };
        let nextCursor = Option.getOrUndefined(cursor);
        for (;;) {
          const page = nextCursor;
          const data = yield* ApiKeys.list({ ...query, cursor: page }).pipe(
            client.provide,
            Effect.mapError((error) =>
              toCliApiError("Could not list API keys", error, { cursor: page ?? null }),
            ),
          );
          if (isJsonLinesRequested()) {
            for (const item of data.items) yield* printJsonLine(item);
          } else if (json) {
            return yield* printJson(data);
          } else {
            if (data.items.length === 0) return yield* Console.log("No API keys found.");
            for (const key of data.items) {
              yield* printFields(keyFields(key));
              yield* Console.log("");
            }
            if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
          }
          if (!all || data.nextCursor === null) return;
          nextCursor = data.nextCursor;
        }
      }),
    ),
  ),
);

const get = Command.make("get", { id: idArgument, json: jsonFlag }).pipe(
  Command.withDescription("Get an API key's metadata and access (never its secret)"),
  Command.withExamples([{ command: "samva api-keys get key_abc123 --json" }]),
  Command.withHandler(({ id, json }) =>
    withJsonQuiet(
      json,
      Effect.gen(function* () {
        const client = yield* getClientProvider;
        const key = yield* ApiKeys.get({ id }).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError("Could not get API key", error)),
        );
        if (json) return yield* printJson(key);
        yield* printFields(keyFields(key));
      }),
    ),
  ),
);

const create = Command.make("create", {
  name: Flag.String("name").pipe(Flag.withDescription("Key name, 1 to 32 characters")),
  description: Flag.String("description").pipe(
    Flag.withDescription("What the key is for"),
    Flag.optional,
  ),
  expiresAt: Flag.String("expires-at").pipe(
    Flag.withDescription("When the key stops working, an ISO 8601 instant"),
    Flag.optional,
  ),
  grant: Flag.String("grant").pipe(
    Flag.withDescription(
      `Give a restricted key a resource at a level, <resource>=read|write (repeatable). Resources: ${GRANTABLE_RESOURCES.join(", ")}`,
    ),
    Flag.atLeast(0),
  ),
  mailboxPermission: Flag.Literals("mailbox-permission", API_KEY_MAILBOX_ACTIONS).pipe(
    Flag.withDescription(
      `Let a restricted key work in mailboxes with this action (repeatable): ${API_KEY_MAILBOX_ACTIONS.join(", ")}`,
    ),
    Flag.atLeast(0),
  ),
  mailbox: Flag.String("mailbox").pipe(
    Flag.withSchema(MailboxId),
    Flag.withDescription(
      "Confine the mailbox access to this mailbox (repeatable); omit for every mailbox the owner reaches",
    ),
    Flag.atLeast(0),
  ),
  sendMode: Flag.Literals("send-mode", mailboxSendModes).pipe(
    Flag.withDescription(
      "With approval, each send waits until a person other than the key approves it (default send)",
    ),
    Flag.optional,
  ),
  namespace: Flag.String("namespace").pipe(
    Flag.withSchema(NamespaceId),
    Flag.withDescription("Confine a restricted key to one namespace (ns_...)"),
    Flag.optional,
  ),
  fullAccess: Flag.Boolean("full-access").pipe(
    Flag.withDescription("Give the key its owner's full access instead of restricted access"),
    Flag.withDefault(false),
  ),
  dryRun: dryRunFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Create an API key. The secret is shown once; the API refuses access you do not hold.",
  ),
  Command.withExamples([
    { command: "samva api-keys create --name ci --grant email=write --dry-run" },
    {
      command:
        "samva api-keys create --name agent --mailbox-permission read --mailbox-permission send --mailbox mbx_1234567890123456 --send-mode approval",
      description: "A key that works in one mailbox and needs a person to approve each send",
    },
    {
      command: "samva api-keys create --name ci --grant email=write --json | jq -r .data.key",
      description: "Pipe the secret into another tool",
    },
    {
      command:
        "samva api-keys create --name deploy --full-access --expires-at 2027-01-01T00:00:00Z",
    },
  ]),
  Command.withHandler(
    ({
      name,
      description,
      expiresAt,
      grant,
      mailboxPermission,
      mailbox,
      sendMode,
      namespace,
      fullAccess,
      dryRun,
      json,
    }) =>
      withJsonQuiet(
        json,
        Effect.gen(function* () {
          const access = yield* accessFromFlags(
            grant,
            fullAccess,
            { permissions: mailboxPermission, mailboxIds: mailbox, sendMode },
            namespace,
          );
          const expires = yield* Option.match(expiresAt, {
            onNone: () => Effect.void,
            onSome: parseExpiresAt,
          });
          const payload = yield* decodeRequest(ApiKeys.CreatePayload, {
            name,
            ...Option.match(description, {
              onNone: () => ({}),
              onSome: (value) => ({ description: value }),
            }),
            ...(expires === undefined ? {} : { expiresAt: expires }),
            access,
          });
          if (dryRun) {
            if (json) {
              return yield* printJson({
                dryRun: true,
                action: "api-keys.create",
                request: payload,
              });
            }
            return yield* printFields([
              ["Action", "api-keys.create"],
              ["Name", payload.name],
              ["Description", payload.description],
              ["Access", describeAccess(payload.access)],
              ["Expires", payload.expiresAt],
            ]);
          }
          const client = yield* getClientProvider;
          const { key, ...apiKey } = yield* ApiKeys.create(payload).pipe(
            client.provide,
            Effect.mapError((error) => toCliApiError("Could not create API key", error)),
          );
          const warning =
            "This API key is shown once. Store it now; `samva api-keys rotate` issues a replacement.";
          // The secret is Redacted on the Effect surface; unwrap it here, the one place the
          // customer can read it.
          const secret = Redacted.value(key);
          if (json) return yield* printJson({ apiKey, key: secret, displayOnce: true, warning });
          yield* Console.error(`WARNING: ${warning}`);
          yield* printFields([...keyFields(apiKey), ["API key", secret]]);
        }),
      ),
  ),
);

const update = Command.make("update", {
  id: idArgument,
  name: Flag.String("name").pipe(Flag.withDescription("New key name"), Flag.optional),
  description: Flag.String("description").pipe(
    Flag.withDescription("New description"),
    Flag.optional,
  ),
  sendMode: Flag.Literals("send-mode", mailboxSendModes).pipe(
    Flag.withDescription(
      "Change a mailbox key's send mode: approval holds each send for a person other than the key, send releases them. Takes a person signed in with samva login",
    ),
    Flag.optional,
  ),
  dryRun: dryRunFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Rename an API key, change its description, or change a mailbox key's send mode. Its other access is fixed at creation; create a new key to change it.",
  ),
  Command.withExamples([
    { command: "samva api-keys update key_abc123 --name ci-prod --dry-run" },
    { command: "samva api-keys update key_abc123 --send-mode approval" },
  ]),
  Command.withHandler(({ id, name, description, sendMode, dryRun, json }) =>
    withJsonQuiet(
      json,
      Effect.gen(function* () {
        if (Option.isNone(name) && Option.isNone(description) && Option.isNone(sendMode)) {
          return yield* new CliUsageError({
            code: "update_required",
            message: "Pass --name, --description, --send-mode, or a combination.",
          });
        }
        const payload = yield* decodeRequest(ApiKeys.UpdatePayload, {
          ...Option.match(name, { onNone: () => ({}), onSome: (value) => ({ name: value }) }),
          ...Option.match(description, {
            onNone: () => ({}),
            onSome: (value) => ({ description: value }),
          }),
          ...Option.match(sendMode, {
            onNone: () => ({}),
            onSome: (value) => ({ mailboxes: { sendMode: value } }),
          }),
        });
        if (dryRun) {
          if (json) {
            return yield* printJson({
              dryRun: true,
              action: "api-keys.update",
              id,
              request: payload,
            });
          }
          return yield* printFields([
            ["Action", "api-keys.update"],
            ["API key", id],
            ["Name", payload.name],
            ["Description", payload.description],
            ["Send mode", payload.mailboxes?.sendMode],
          ]);
        }
        const client = yield* getClientProvider;
        const key = yield* ApiKeys.update({ id, ...payload }).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError("Could not update API key", error)),
        );
        if (json) return yield* printJson(key);
        yield* printFields(keyFields(key));
      }),
    ),
  ),
);

const revoke = Command.make("revoke", {
  id: idArgument,
  dryRun: dryRunFlag,
  yes: yesFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Revoke an API key so it can no longer authenticate. Revocation is final; its record stays listable.",
  ),
  Command.withExamples([
    { command: "samva api-keys revoke key_abc123 --dry-run" },
    { command: "samva api-keys revoke key_abc123 --yes" },
  ]),
  Command.withHandler(({ id, dryRun, yes, json }) =>
    withJsonQuiet(
      json,
      Effect.gen(function* () {
        if (dryRun) {
          return yield* json
            ? printJson({ dryRun: true, action: "api-keys.revoke", id })
            : Console.log(`[dry-run] Would revoke API key ${id}.`);
        }
        yield* confirmDestructive({
          yes,
          json,
          message: `Revoke API key ${id}? It stops authenticating requests immediately, and revocation is final.`,
          nonInteractiveMessage:
            "Revoking an API key requires --yes in non-interactive mode. Preview with --dry-run.",
        });
        const client = yield* getClientProvider;
        const result = yield* ApiKeys.revoke({ id }).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError("Could not revoke API key", error)),
        );
        if (json) return yield* printJson(result);
        yield* Console.log(`Revoked API key ${id}.`);
      }),
    ),
  ),
);

const rotate = Command.make("rotate", {
  id: idArgument,
  dryRun: dryRunFlag,
  yes: yesFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Replace an API key with a new secret, same owner, name, and access. The old key stops working at once.",
  ),
  Command.withExamples([
    { command: "samva api-keys rotate key_abc123 --dry-run" },
    { command: "samva api-keys rotate key_abc123 --yes --json | jq -r .data.key" },
  ]),
  Command.withHandler(({ id, dryRun, yes, json }) =>
    withJsonQuiet(
      json,
      Effect.gen(function* () {
        if (dryRun) {
          return yield* json
            ? printJson({ dryRun: true, action: "api-keys.rotate", id })
            : Console.log(`[dry-run] Would rotate API key ${id}.`);
        }
        yield* confirmDestructive({
          yes,
          json,
          message: `Rotate API key ${id}? The current key stops working immediately.`,
          nonInteractiveMessage:
            "Rotating an API key requires --yes in non-interactive mode. Preview with --dry-run.",
        });
        const client = yield* getClientProvider;
        const { key, ...apiKey } = yield* ApiKeys.rotate({ id }).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError("Could not rotate API key", error)),
        );
        const warning =
          "This API key is shown once. The previous key no longer works; store the new one now.";
        const secret = Redacted.value(key);
        if (json) return yield* printJson({ apiKey, key: secret, displayOnce: true, warning });
        yield* Console.error(`WARNING: ${warning}`);
        yield* printFields([...keyFields(apiKey), ["API key", secret]]);
      }),
    ),
  ),
);

export const apiKeysCommand = Command.make("api-keys").pipe(
  Command.withDescription("Create, inspect, rotate, and revoke the organization's API keys"),
  Command.withExamples([{ command: "samva api-keys list --json" }]),
  Command.withSubcommands([list, get, create, update, rotate, revoke]),
);
