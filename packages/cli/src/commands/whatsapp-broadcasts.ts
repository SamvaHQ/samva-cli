import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";

import { SamvaCliError, toCliApiError } from "../errors";
import { getAuthenticatedJson, postAuthenticatedJson } from "../lib/client";
import { jsonFlag, printFields, printJson, truncateForDisplay } from "../lib/output";
import { campaignPacingFields } from "../lib/run-hold";
import { parseTagList } from "./campaigns";

/**
 * `samva whatsapp broadcasts create | run` and `samva whatsapp templates stats` — a WhatsApp
 * template sent to an audience, and what became of it.
 *
 * A broadcast is a campaign whose content is an approved template, so it reaches contacts outside
 * a customer service window. The public SDK describes the email channel only, so the commands call
 * `/v1/campaigns` and the hidden stats endpoint directly with the CLI's credentials, as `samva
 * whatsapp send` does. They live in the unmounted `whatsapp` tree so the public binary advertises
 * nothing flagged.
 */

const CONTACT_FIELDS = [
  "id",
  "name",
  "displayName",
  "externalId",
  "phone",
  "email",
  "firstName",
  "lastName",
  "company",
  "jobTitle",
] as const;

export type WhatsAppBinding =
  | { readonly contact: (typeof CONTACT_FIELDS)[number] }
  | { readonly customField: string };

const usage = (message: string) => new SamvaCliError({ message });

/** Split `name=value` at the first `=`; both sides must be non-empty. */
const splitPair = (flag: string, entry: string) => {
  const at = entry.indexOf("=");
  const name = at < 0 ? "" : entry.slice(0, at).trim();
  const value = at < 0 ? "" : entry.slice(at + 1).trim();
  return name === "" || value === ""
    ? Effect.fail(usage(`--${flag} takes param=value, got "${entry}".`))
    : Effect.succeed([name, value] as const);
};

/**
 * `--bind param=contact.<field>` or `--bind param=customField.<key>` into the API's bindings
 * object. A parameter bound twice, or a field the contact does not carry, is refused.
 */
export const parseBindings = (entries: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const bindings: Record<string, WhatsAppBinding> = {};
    for (const entry of entries) {
      const [param, source] = yield* splitPair("bind", entry);
      if (param in bindings) return yield* usage(`--bind names parameter "${param}" twice.`);
      const dot = source.indexOf(".");
      const kind = dot < 0 ? source : source.slice(0, dot);
      const key = dot < 0 ? "" : source.slice(dot + 1);
      if (kind === "contact" && (CONTACT_FIELDS as ReadonlyArray<string>).includes(key)) {
        bindings[param] = { contact: key as (typeof CONTACT_FIELDS)[number] };
      } else if (kind === "customField" && key !== "") {
        bindings[param] = { customField: key };
      } else {
        return yield* usage(
          `--bind ${param}=${source} must read contact.<field> (${CONTACT_FIELDS.join(", ")}) or customField.<key>.`,
        );
      }
    }
    return bindings;
  });

/** `--data param=value` into literal template data every recipient receives. */
export const parseLiteralData = (entries: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const data: Record<string, string> = {};
    for (const entry of entries) {
      const [param, value] = yield* splitPair("data", entry);
      if (param in data) return yield* usage(`--data names parameter "${param}" twice.`);
      data[param] = value;
    }
    return data;
  });

export interface WhatsAppBroadcastInput {
  readonly name: string;
  readonly template: string;
  readonly data: Readonly<Record<string, string>>;
  readonly bindings: Readonly<Record<string, WhatsAppBinding>>;
  readonly businessAccountId: string | undefined;
  readonly includeTags: ReadonlyArray<string>;
  readonly excludeTags: ReadonlyArray<string>;
  readonly groupIds: ReadonlyArray<string>;
  readonly contactIds: ReadonlyArray<string>;
}

const nonEmpty = <A>(values: ReadonlyArray<A>) => (values.length > 0 ? [...values] : undefined);

/** The `POST /v1/campaigns` payload for a WhatsApp template broadcast. */
export const whatsappBroadcastPayload = (input: WhatsAppBroadcastInput) => ({
  name: input.name,
  channel: "whatsapp" as const,
  content: {
    channel: "whatsapp" as const,
    whatsapp: {
      template: input.template,
      ...(Object.keys(input.data).length === 0 ? {} : { templateData: input.data }),
      ...(Object.keys(input.bindings).length === 0 ? {} : { bindings: input.bindings }),
      ...(input.businessAccountId === undefined
        ? {}
        : { businessAccountId: input.businessAccountId }),
    },
  },
  audience: {
    includeTags: nonEmpty(input.includeTags),
    excludeTags: nonEmpty(input.excludeTags),
    groupIds: nonEmpty(input.groupIds),
    contactIds: nonEmpty(input.contactIds),
  },
});

const WireCampaign = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  channel: Schema.String,
});

const WireRun = Schema.Struct({
  id: Schema.String,
  campaignId: Schema.String,
  status: Schema.String,
  scheduledFor: Schema.String,
  totalRecipients: Schema.Finite,
  dispatchedCount: Schema.Finite,
  failedCount: Schema.Finite,
  skippedCount: Schema.Finite,
  skippedReasons: Schema.Array(Schema.Struct({ reason: Schema.String, count: Schema.Finite })),
  pendingCount: Schema.Finite,
  estimatedCompletionAt: Schema.NullOr(Schema.String),
  holdReason: Schema.NullOr(Schema.String),
  holdUntil: Schema.NullOr(Schema.String),
  capacityWarning: Schema.NullOr(Schema.String),
});

const decode =
  <S extends Schema.Decoder<unknown>>(schema: S, what: string) =>
  (body: unknown) =>
    Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError(() => usage(`The API answered with an unreadable ${what}.`)),
    );

/** Skipped recipients by reason, as one line. */
export const skippedLine = (
  reasons: ReadonlyArray<{ readonly reason: string; readonly count: number }>,
) => reasons.map(({ reason, count }) => `${reason} ${count}`).join(", ");

const BROADCAST_NEXT: Readonly<Record<string, string>> = {
  ValidationError:
    "Fix the listed fields: bind or give a --data value for every template parameter, drop parameters the template does not have, and check that the template is approved (`samva whatsapp templates list`).",
  FlagDisabledError: "WhatsApp is not enabled for this organization.",
};

const withNext = (message: string, error: unknown): SamvaCliError => {
  const failure = toCliApiError(message, error);
  const next = failure.api === undefined ? undefined : BROADCAST_NEXT[failure.api.reason];
  return next === undefined || failure.api === undefined
    ? failure
    : new SamvaCliError({
        message: failure.message,
        api: { ...failure.api, next },
        details: failure.details,
      });
};

const scheduleRun = (campaignId: string, at: string | undefined, key: string | undefined) =>
  postAuthenticatedJson(`/v1/campaigns/${encodeURIComponent(campaignId)}/runs`, {
    ...(key === undefined ? {} : { headers: { "idempotency-key": key } }),
    body: {
      ...(at === undefined ? {} : { scheduledFor: at }),
    },
  }).pipe(
    Effect.mapError((error) => withNext("Could not schedule run", error)),
    Effect.flatMap(decode(WireRun, "run")),
  );

const printRunFields = (run: typeof WireRun.Type) =>
  printFields([
    ["Run ID", run.id],
    ["Campaign", run.campaignId],
    ["Status", run.status],
    ["Scheduled for", run.scheduledFor],
    ["Recipients", String(run.totalRecipients)],
    ["Dispatched", String(run.dispatchedCount)],
    ["Failed", String(run.failedCount)],
    ["Skipped", String(run.skippedCount)],
    ["Skipped by reason", skippedLine(run.skippedReasons)],
    ...campaignPacingFields(run, { warning: false }),
  ]);

/** The schedule-time capacity warning is advisory: it goes to stderr and never fails the command. */
const warnCapacity = (run: typeof WireRun.Type) =>
  run.capacityWarning === null ? Effect.void : Console.error(`Warning: ${run.capacityWarning}`);

const ABSOLUTE_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const checkInstant = (at: string | undefined) =>
  at === undefined || (ABSOLUTE_INSTANT.test(at) && !Number.isNaN(Date.parse(at)))
    ? Effect.void
    : Effect.fail(
        usage(
          "--at must be an absolute ISO 8601 instant with Z or an offset, e.g. 2026-08-01T09:00:00Z.",
        ),
      );

const list = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.atLeast(0));
const atFlag = Flag.String("at").pipe(
  Flag.withDescription("Absolute run start instant as ISO 8601; requires --run (default: now)"),
  Flag.optional,
);
const idempotencyKeyFlag = Flag.String("idempotency-key").pipe(
  Flag.withDescription("Organization-scoped key so retries return the original run"),
  Flag.optional,
);

const create = Command.make("create", {
  name: Flag.String("name").pipe(Flag.withDescription("Broadcast name")),
  template: Flag.String("template").pipe(
    Flag.withDescription("Approved WhatsApp template, by id (tmpl_…) or slug"),
  ),
  bind: list(
    "bind",
    "Fill a template parameter per recipient: param=contact.<field> or param=customField.<key> (repeatable)",
  ),
  data: list("data", "Literal parameter value every recipient gets: param=value (repeatable)"),
  from: Flag.String("from").pipe(
    Flag.withDescription(
      "Business account that sends (waba_…); the default number's account when omitted",
    ),
    Flag.optional,
  ),
  includeTags: list("include-tags", "Contact tags to include (comma-separated or repeated)"),
  excludeTags: list("exclude-tags", "Contact tags to exclude (comma-separated or repeated)"),
  groups: list(
    "groups",
    "Contact group ids whose members join the audience (comma-separated or repeated)",
  ),
  contactIds: list("contact-ids", "Explicit contact ids (comma-separated or repeated)"),
  run: Flag.Boolean("run").pipe(
    Flag.withDescription("Also schedule a run (now, or at --at) once the broadcast is created"),
    Flag.withDefault(false),
  ),
  at: atFlag,
  idempotencyKey: idempotencyKeyFlag,
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Validate the flags and print the request without calling the API"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Create a WhatsApp broadcast: an approved template sent to tags, groups, or explicit contacts. Every template parameter needs a --bind or --data; scheduling checks them against the approved registration.",
  ),
  Command.withExamples([
    {
      command:
        "samva whatsapp broadcasts create --name Restock --template restock --bind name=contact.firstName --bind plan=customField.plan --data offer=SAVE10 --include-tags customers",
      description: "Fill parameters from each contact, plus one literal value",
    },
    {
      command:
        "samva whatsapp broadcasts create --name Restock --template restock --groups cgrp_123 --run --at 2026-08-01T09:00:00Z",
      description: "Create the broadcast and schedule its run",
    },
  ]),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const at = Option.getOrUndefined(input.at);
      if (at !== undefined && !input.run) return yield* usage("--at requires --run.");
      if (Option.isSome(input.idempotencyKey) && !input.run) {
        return yield* usage("--idempotency-key requires --run.");
      }
      yield* checkInstant(at);
      const includeTags = parseTagList(input.includeTags);
      const excludeTags = parseTagList(input.excludeTags);
      const groupIds = parseTagList(input.groups);
      const contactIds = parseTagList(input.contactIds);
      if (includeTags.length + groupIds.length + contactIds.length === 0) {
        return yield* usage(
          "Provide an audience: at least one of --include-tags, --groups, or --contact-ids (--exclude-tags only narrows it).",
        );
      }
      const payload = whatsappBroadcastPayload({
        name: input.name,
        template: input.template,
        data: yield* parseLiteralData(input.data),
        bindings: yield* parseBindings(input.bind),
        businessAccountId: Option.getOrUndefined(input.from),
        includeTags,
        excludeTags,
        groupIds,
        contactIds,
      });
      if (input.dryRun) {
        if (input.json) return yield* printJson({ dryRun: true, request: payload });
        yield* Effect.logInfo("Dry run — no broadcast created.\n");
        return yield* Console.log(
          `Payload:\n${truncateForDisplay(JSON.stringify(payload, null, 2))}`,
        );
      }
      const campaign = yield* postAuthenticatedJson("/v1/campaigns", { body: payload }).pipe(
        Effect.mapError((error) => withNext("Failed to create broadcast", error)),
        Effect.flatMap(decode(WireCampaign, "campaign")),
      );
      const run = input.run
        ? yield* scheduleRun(campaign.id, at, Option.getOrUndefined(input.idempotencyKey))
        : undefined;
      if (input.json) return yield* printJson(run === undefined ? campaign : { campaign, run });
      yield* Effect.logInfo("Broadcast created.\n");
      yield* printFields([
        ["ID", campaign.id],
        ["Name", campaign.name],
        ["Channel", campaign.channel],
      ]);
      if (run === undefined) {
        return yield* Effect.logInfo(
          `\nSchedule a run:  samva whatsapp broadcasts run ${campaign.id}`,
        );
      }
      yield* Effect.logInfo("\nRun scheduled.\n");
      yield* printRunFields(run);
      yield* warnCapacity(run);
    }).pipe(input.json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const run = Command.make("run", {
  campaignId: Argument.String("campaignId").pipe(
    Argument.withDescription("Broadcast (campaign) id"),
  ),
  at: Flag.String("at").pipe(
    Flag.withDescription("Absolute run start instant as ISO 8601 (default: now)"),
    Flag.optional,
  ),
  idempotencyKey: idempotencyKeyFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Schedule a run of a WhatsApp broadcast. Meta sets the messaging limit per business portfolio, and every number in the portfolio shares it. A run sends only what the limit has room for and resumes itself with the rest, sooner if Meta raises the limit; a large audience prints a warning. Read progress, including why recipients were skipped or are waiting, with `samva campaigns runs get`.",
  ),
  Command.withExamples([
    { command: "samva whatsapp broadcasts run camp_abc123", description: "Send now" },
    {
      command: "samva whatsapp broadcasts run camp_abc123 --at 2026-08-01T09:00:00Z",
      description: "Send at a future time",
    },
  ]),
  Command.withHandler(({ campaignId, at, idempotencyKey, json }) =>
    Effect.gen(function* () {
      const atValue = Option.getOrUndefined(at);
      yield* checkInstant(atValue);
      const scheduled = yield* scheduleRun(
        campaignId,
        atValue,
        Option.getOrUndefined(idempotencyKey),
      );
      if (json) return yield* printJson(scheduled);
      yield* Effect.logInfo("Run scheduled.\n");
      yield* printRunFields(scheduled);
      yield* warnCapacity(scheduled);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

export const broadcasts = Command.make("broadcasts").pipe(
  Command.withDescription("Send an approved WhatsApp template to an audience"),
  Command.withSubcommands([create, run]),
);

// ── Template stats ────────────────────────────────────────────────────────────

const StatsSource = Schema.Union([
  Schema.Struct({ type: Schema.Literal("campaign"), campaignId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("journey"),
    journeyId: Schema.String,
    nodeId: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("direct") }),
]);
const StatsRow = Schema.Struct({
  templateId: Schema.String,
  templateSlug: Schema.String,
  name: Schema.String,
  language: Schema.String,
  category: Schema.NullOr(Schema.String),
  source: StatsSource,
  sent: Schema.Finite,
  delivered: Schema.Finite,
  read: Schema.Finite,
  failed: Schema.Finite,
  estimatedProviderCosts: Schema.Array(
    Schema.Struct({ amount: Schema.String, currency: Schema.String }),
  ),
});
const StatsList = Schema.Struct({ items: Schema.Array(StatsRow) });

export interface TemplateStatsFilter {
  readonly startDate?: string | undefined;
  readonly endDate?: string | undefined;
  readonly templateId?: string | undefined;
  readonly campaignId?: string | undefined;
  readonly journeyId?: string | undefined;
}

/** The `GET /v1/whatsapp/templates/stats` path for the given filters. */
export const templateStatsPath = (filter: TemplateStatsFilter): string => {
  const query = new URLSearchParams();
  for (const key of ["startDate", "endDate", "templateId", "campaignId", "journeyId"] as const) {
    const value = filter[key];
    if (value !== undefined) query.set(key, value);
  }
  const text = query.toString();
  return text === "" ? "/v1/whatsapp/templates/stats" : `/v1/whatsapp/templates/stats?${text}`;
};

/** A stats source as one cell. */
export const sourceLabel = (source: typeof StatsSource.Type): string =>
  source.type === "campaign"
    ? `campaign ${source.campaignId}`
    : source.type === "journey"
      ? `journey ${source.journeyId} / ${source.nodeId}`
      : "direct";

const optionalString = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.optional);

export const templatesStats = Command.make("stats", {
  startDate: optionalString("start-date", "Count messages created at or after this ISO 8601 date"),
  endDate: optionalString("end-date", "Count messages created before this ISO 8601 date"),
  templateId: optionalString("template-id", "Only this template (tmpl_…)"),
  campaignId: optionalString("campaign-id", "Only messages a campaign sent (camp_…)"),
  journeyId: optionalString("journey-id", "Only messages a journey sent (jrny_…)"),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Sent, delivered, read, and failed counts and Meta's estimated cost for each WhatsApp template, split by what sent it: a campaign, a journey step, or a direct send",
  ),
  Command.withExamples([
    { command: "samva whatsapp templates stats", description: "Every template, all time" },
    {
      command: "samva whatsapp templates stats --campaign-id camp_abc123 --start-date 2026-08-01",
      description: "How one broadcast performed",
    },
  ]),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const body = yield* getAuthenticatedJson(
        templateStatsPath({
          startDate: Option.getOrUndefined(flags.startDate),
          endDate: Option.getOrUndefined(flags.endDate),
          templateId: Option.getOrUndefined(flags.templateId),
          campaignId: Option.getOrUndefined(flags.campaignId),
          journeyId: Option.getOrUndefined(flags.journeyId),
        }),
      ).pipe(
        Effect.mapError((error) => toCliApiError("Could not read WhatsApp template stats", error)),
      );
      const stats = yield* decode(StatsList, "stats response")(body);
      if (flags.json) return yield* printJson(stats);
      if (stats.items.length === 0) {
        return yield* Console.log("No WhatsApp template messages in this range.");
      }
      for (const row of stats.items) {
        yield* printFields([
          ["Template", `${row.templateSlug} (${row.templateId})`],
          [
            "Name",
            `${row.name} (${row.language})${row.category === null ? "" : `, ${row.category}`}`,
          ],
          ["Source", sourceLabel(row.source)],
          ["Sent", String(row.sent)],
          ["Delivered", String(row.delivered)],
          ["Read", String(row.read)],
          ["Failed", String(row.failed)],
          [
            "Estimated cost",
            row.estimatedProviderCosts.map((cost) => `${cost.amount} ${cost.currency}`).join(", "),
          ],
        ]);
        yield* Console.log("");
      }
    }).pipe(flags.json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
