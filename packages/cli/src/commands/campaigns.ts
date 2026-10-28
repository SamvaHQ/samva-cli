import { IssuePin } from "@samva/core/contacts/issues";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import type { JsonValue } from "samva/effect";
import * as Campaigns from "samva/effect/campaigns";

import { CliUsageError, SamvaCliError, toCliApiError } from "../errors";
import { getClientProvider } from "../lib/client";
import { confirmDestructive } from "../lib/confirm";
import {
  jsonFlag,
  printFields,
  printJson,
  printJsonLine,
  truncateForDisplay,
  withoutSeries,
} from "../lib/output";
import { campaignPacingFields } from "../lib/run-hold";
import { isJsonLinesRequested } from "../lib/runtime";
import {
  inputContractIdFlag,
  publicationIdFlag,
  resolveTemplateReference,
} from "../lib/template-reference";

type JsonRecord = { readonly [x: string]: JsonValue };

/** Ergonomic input for `Campaigns.create`, derived from the SDK facade. */
type CampaignsCreateRequestJson = Parameters<typeof Campaigns.create>[0];
/** Ergonomic input for `Campaigns.update`, minus the `id` passed separately. */
type CampaignsUpdateRequestJson = Omit<Parameters<typeof Campaigns.update>[0], "id">;

const CAMPAIGN_STATUSES = ["draft", "archived"] as const;
const RUN_STATUSES = [
  "scheduled",
  "resolving",
  "dispatching",
  "paused",
  "completed",
  "cancelled",
  "failed",
] as const;
const RECIPIENT_STATUSES = ["pending", "dispatching", "dispatched", "failed", "skipped"] as const;
const ABSOLUTE_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const isAbsoluteInstant = (value: string): boolean => {
  const match = ABSOLUTE_INSTANT_PATTERN.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  return (
    calendarDate.getUTCFullYear() === year &&
    calendarDate.getUTCMonth() === month - 1 &&
    calendarDate.getUTCDate() === day
  );
};

/**
 * Flatten repeated and comma-separated flag values into a clean tag list.
 * `--include-tags a,b --include-tags c` and `--include-tags a --include-tags b`
 * both collapse to `["a", "b", ...]`. Pure so it can be unit-tested.
 */
export const parseTagList = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  values.flatMap((value) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );

/** Clean inputs for an email campaign, already resolved from flags. */
export interface CampaignCreateInput {
  readonly name: string;
  readonly subject: string | undefined;
  readonly preheader?: string | undefined;
  readonly issue?: IssuePin | undefined;
  readonly html: string | undefined;
  readonly text: string | undefined;
  readonly templateId: string | undefined;
  readonly publicationId: string | undefined;
  readonly inputContractId: string | undefined;
  readonly templateSlug: string | undefined;
  readonly templateData: JsonRecord | undefined;
  readonly includeTags: ReadonlyArray<string>;
  readonly excludeTags: ReadonlyArray<string>;
  readonly contactIds: ReadonlyArray<string>;
  readonly topicId: string;
  readonly pageSize: number | undefined;
  readonly tracking: { readonly opens?: boolean; readonly clicks?: boolean } | undefined;
}

/**
 * Assemble the `campaigns.create` email payload from resolved flags. Pure so the
 * flag-to-request mapping can be unit-tested without the network.
 */
export const assembleCampaignCreatePayload = (
  input: CampaignCreateInput,
): CampaignsCreateRequestJson => {
  const hasPolicy = input.pageSize !== undefined;
  return {
    name: input.name,
    channel: "email",
    content: {
      channel: "email",
      ...(input.issue === undefined ? {} : { issue: input.issue }),
      email: {
        subject: input.subject,
        ...(input.preheader === undefined ? {} : { preheader: input.preheader }),
        html: input.html,
        text: input.text,
        templateId: input.templateId,
        ...(input.publicationId === undefined ? {} : { publicationId: input.publicationId }),
        ...(input.inputContractId === undefined ? {} : { inputContractId: input.inputContractId }),
        templateSlug: input.templateSlug,
        templateData: input.templateData,
        ...(input.tracking === undefined ? {} : { tracking: input.tracking }),
      },
    },
    audience: {
      topicId: input.topicId,
      includeTags: input.includeTags.length > 0 ? [...input.includeTags] : undefined,
      excludeTags: input.excludeTags.length > 0 ? [...input.excludeTags] : undefined,
      contactIds: input.contactIds.length > 0 ? [...input.contactIds] : undefined,
    },
    policy: hasPolicy ? { pageSize: input.pageSize } : undefined,
  };
};

const parseTemplateData = (
  raw: Option.Option<string>,
): Effect.Effect<JsonRecord | undefined, SamvaCliError> =>
  Option.match(raw, {
    // @effect-diagnostics-next-line effectSucceedWithVoid:off -- undefined is a real success value (no template data), not a void outcome; Effect.void is not assignable to `JsonRecord | undefined`.
    onNone: () => Effect.succeed(undefined),
    onSome: (value) =>
      Effect.try({
        try: () => JSON.parse(value) as unknown,
        catch: () => new SamvaCliError({ message: "--template-data must be a JSON object." }),
      }).pipe(
        Effect.flatMap((parsed) =>
          Predicate.isObject(parsed)
            ? Effect.succeed(parsed as JsonRecord)
            : Effect.fail(new SamvaCliError({ message: "--template-data must be a JSON object." })),
        ),
      ),
  });

const issuePathFlag = Flag.String("issue-path").pipe(
  Flag.withDescription("Saved Markdown issue path in the audience topic repository"),
  Flag.optional,
);
const issueCommitFlag = Flag.String("issue-commit").pipe(
  Flag.withDescription("Exact saved Git commit from newsletters issues save"),
  Flag.optional,
);
const preheaderFlag = Flag.String("preheader").pipe(
  Flag.withDescription("Email preview text; an issue supplies its own preheader"),
  Flag.optional,
);
const resolveIssue = (
  path: Option.Option<string>,
  commit: Option.Option<string>,
  mixed: readonly Option.Option<string>[],
) =>
  Effect.gen(function* () {
    if (Option.isNone(path) && Option.isNone(commit)) return undefined;
    if (Option.isNone(path) || Option.isNone(commit))
      return yield* new CliUsageError({
        code: "issue_pin_required",
        message:
          "Pass --issue-path and --issue-commit together, using the commit from samva newsletters issues save.",
      });
    if (mixed.some(Option.isSome))
      return yield* new CliUsageError({
        code: "mixed_issue_content",
        message:
          "An issue supplies its subject, preheader and body. Omit --subject, --preheader, --html, --text and template reference flags.",
      });
    return yield* Schema.decodeEffect(IssuePin)({ path: path.value, commit: commit.value }).pipe(
      Effect.mapError(
        () =>
          new CliUsageError({
            code: "invalid_issue_pin",
            message:
              "Use --issue-path issues/<name>.md and --issue-commit <40-character lowercase Git SHA>.",
          }),
      ),
    );
  });

const nameFlag = Flag.String("name").pipe(Flag.withDescription("Campaign name"));
const subjectFlag = Flag.String("subject").pipe(
  Flag.withDescription("Email subject line"),
  Flag.optional,
);
const htmlFlag = Flag.String("html").pipe(Flag.withDescription("HTML body"), Flag.optional);
const textFlag = Flag.String("text").pipe(Flag.withDescription("Plain-text body"), Flag.optional);
const templateIdFlag = Flag.String("template-id").pipe(
  Flag.withDescription("Template id to render instead of inline body"),
  Flag.optional,
);
const templateSlugFlag = Flag.String("template-slug").pipe(
  Flag.withDescription("Template handle to render instead of inline body, e.g. welcome-email"),
  Flag.optional,
);
const templateDataFlag = Flag.String("template-data").pipe(
  Flag.withDescription("JSON object of variables for the template"),
  Flag.optional,
);
const includeTagsFlag = Flag.String("include-tags").pipe(
  Flag.withDescription("Contact tags to include (comma-separated or repeated)"),
  Flag.atLeast(0),
);
const excludeTagsFlag = Flag.String("exclude-tags").pipe(
  Flag.withDescription(
    "Contact tags to exclude from the include set (comma-separated or repeated)",
  ),
  Flag.atLeast(0),
);
const contactIdsFlag = Flag.String("contact-ids").pipe(
  Flag.withDescription("Explicit contact ids to target (comma-separated or repeated)"),
  Flag.atLeast(0),
);
const topicIdFlag = Flag.String("topic-id").pipe(
  Flag.withDescription("Topic whose subscription eligibility defines the audience"),
  Flag.optional,
);
const pageSizeFlag = Flag.Int("page-size").pipe(
  Flag.withDescription("Recipients dispatched per batch"),
  Flag.optional,
);
const dryRunFlag = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Validate inputs and print the request payload without calling the API"),
  Flag.withDefault(false),
);
const trackOpensFlag = Flag.Literals("track-opens", ["on", "off"]).pipe(
  Flag.withDescription("Override open tracking for campaign sends; recipient opt-out wins"),
  Flag.optional,
);
const trackClicksFlag = Flag.Literals("track-clicks", ["on", "off"]).pipe(
  Flag.withDescription("Override click tracking for campaign sends; recipient opt-out wins"),
  Flag.optional,
);
const atFlag = Flag.String("at").pipe(
  Flag.withDescription("Absolute run start instant as ISO 8601 (defaults to now)"),
  Flag.optional,
);
const idempotencyKeyFlag = Flag.String("idempotency-key").pipe(
  Flag.withDescription("Organization-scoped key so retries return the original run"),
  Flag.optional,
);

const campaignStatusFlag = Flag.Literals("status", CAMPAIGN_STATUSES).pipe(
  Flag.withDescription("Filter by status"),
  Flag.optional,
);
const runStatusFlag = Flag.Literals("status", RUN_STATUSES).pipe(
  Flag.withDescription("Filter by run status"),
  Flag.optional,
);
const recipientStatusFlag = Flag.Literals("status", RECIPIENT_STATUSES).pipe(
  Flag.withDescription("Filter by recipient status"),
  Flag.optional,
);
const cursorFlag = Flag.String("cursor").pipe(
  Flag.withDescription("Resume after this nextCursor from a previous page"),
  Flag.optional,
);
const limitFlag = Flag.Int("limit").pipe(Flag.withDescription("Items per page"), Flag.optional);
const allFlag = Flag.Boolean("all").pipe(
  Flag.withDescription("Traverse every page (requires --jsonl)"),
  Flag.withDefault(false),
);

const create = Command.make("create", {
  name: nameFlag,
  subject: subjectFlag,
  preheader: preheaderFlag,
  issuePath: issuePathFlag,
  issueCommit: issueCommitFlag,
  html: htmlFlag,
  text: textFlag,
  templateId: templateIdFlag,
  publicationId: publicationIdFlag,
  inputContractId: inputContractIdFlag,
  templateSlug: templateSlugFlag,
  templateData: templateDataFlag,
  includeTags: includeTagsFlag,
  excludeTags: excludeTagsFlag,
  contactIds: contactIdsFlag,
  topicId: Flag.String("topic-id").pipe(Flag.withDescription("Required topic for this audience")),
  pageSize: pageSizeFlag,
  trackOpens: trackOpensFlag,
  trackClicks: trackClicksFlag,
  dryRun: dryRunFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create an email campaign targeting tags or explicit contacts"),
  Command.withExamples([
    {
      command:
        'samva campaigns create --topic-id unsub_1234567890abcdef --name "Spring launch" --subject "We are live" --html "<h1>Hi</h1>" --include-tags newsletter,customers',
      description: "Campaign to tagged contacts",
    },
    {
      command:
        'samva campaigns create --topic-id unsub_1234567890abcdef --name "VIP note" --subject Hi --html "<p>Hello</p>" --text Hello --contact-ids c_1 --contact-ids c_2 --dry-run',
      description: "Target explicit contacts and preview the payload",
    },
  ]),
  Command.withHandler(
    ({
      name,
      subject,
      preheader,
      issuePath,
      issueCommit,
      html,
      text,
      templateId,
      publicationId,
      inputContractId,
      templateSlug,
      templateData,
      includeTags,
      excludeTags,
      contactIds,
      topicId,
      pageSize,
      trackOpens,
      trackClicks,
      dryRun,
      json,
    }) =>
      Effect.gen(function* () {
        const issue = yield* resolveIssue(issuePath, issueCommit, [
          subject,
          preheader,
          html,
          text,
          templateId,
          templateSlug,
          publicationId,
          inputContractId,
        ]);
        const htmlValue = Option.getOrUndefined(html);
        const textValue = Option.getOrUndefined(text);
        const templateIdValue = Option.getOrUndefined(templateId);
        const templateSlugValue = Option.getOrUndefined(templateSlug);
        const reference = yield* resolveTemplateReference({
          templateId: templateIdValue,
          publicationId: Option.getOrUndefined(publicationId),
          inputContractId: Option.getOrUndefined(inputContractId),
        });
        const templateDataValue = yield* parseTemplateData(templateData);

        if (templateIdValue && templateSlugValue) {
          return yield* new SamvaCliError({
            message: "Use either --template-id or --template-slug, not both.",
          });
        }
        const templateRefValue = templateSlugValue ?? templateIdValue;

        if (
          templateRefValue &&
          (Option.isSome(subject) || Option.isSome(preheader) || htmlValue || textValue)
        ) {
          return yield* new SamvaCliError({
            message:
              "Choose one content source: a template, or inline --subject with --html (and optional --text).",
          });
        }
        if (issue === undefined && !templateRefValue && Option.isNone(subject)) {
          return yield* new SamvaCliError({
            message: "Provide --subject with inline --html, or reference a published template.",
          });
        }
        if (issue === undefined && !templateRefValue && !htmlValue) {
          return yield* new SamvaCliError({
            message: "Provide --html for inline email; --text is an optional fallback.",
          });
        }

        const includeTagsValue = parseTagList(includeTags);
        const excludeTagsValue = parseTagList(excludeTags);
        const contactIdsValue = parseTagList(contactIds);
        const payload = assembleCampaignCreatePayload({
          name,
          subject: Option.getOrUndefined(subject),
          preheader: Option.getOrUndefined(preheader),
          issue,
          html: htmlValue,
          text: textValue,
          templateId: templateIdValue,
          publicationId: reference.publicationId,
          inputContractId: reference.inputContractId,
          templateSlug: templateSlugValue,
          templateData: templateDataValue,
          includeTags: includeTagsValue,
          excludeTags: excludeTagsValue,
          contactIds: contactIdsValue,
          topicId,
          pageSize: Option.getOrUndefined(pageSize),
          tracking:
            Option.isSome(trackOpens) || Option.isSome(trackClicks)
              ? {
                  ...(Option.isSome(trackOpens) ? { opens: trackOpens.value === "on" } : {}),
                  ...(Option.isSome(trackClicks) ? { clicks: trackClicks.value === "on" } : {}),
                }
              : undefined,
        });

        if (dryRun) {
          if (json) return yield* printJson({ dryRun: true, request: payload });
          yield* Effect.logInfo("Dry run — no campaign created.\n");
          yield* printFields([
            ["Name", name],
            ["Topic", topicId],
            ["Include tags", includeTagsValue.join(", ")],
            ["Exclude tags", excludeTagsValue.join(", ")],
            ["Contact ids", contactIdsValue.join(", ")],
          ]);
          return yield* Console.log(
            `\nPayload:\n${truncateForDisplay(JSON.stringify(payload, null, 2))}`,
          );
        }

        const client = yield* getClientProvider;
        const data = yield* Campaigns.create(payload).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError("Failed to create campaign", error)),
        );
        if (json) return yield* printJson(data);
        yield* Effect.logInfo("Campaign created.\n");
        yield* printFields([
          ["ID", data.id],
          ["Name", data.name],
          ["Channel", data.channel],
          ["Definition", data.definition.state],
        ]);
        yield* Effect.logInfo(`\nCreate a run:  samva campaigns runs create ${data.id}`);
      }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const list = Command.make("list", {
  status: campaignStatusFlag,
  cursor: cursorFlag,
  limit: limitFlag,
  all: allFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List campaigns"),
  Command.withExamples([
    { command: "samva campaigns list" },
    { command: "samva campaigns list --status draft --json" },
    { command: "samva campaigns list --all --jsonl", description: "Stream every page as JSONL" },
  ]),
  Command.withHandler(({ status, cursor, limit, all, json }) =>
    Effect.gen(function* () {
      if (all && !isJsonLinesRequested())
        return yield* new CliUsageError({
          code: "all_requires_jsonl",
          message: "--all is an unbounded traversal and requires --jsonl.",
        });
      const cursorValue = Option.getOrUndefined(cursor);
      const limitValue = Option.getOrUndefined(limit);
      const client = yield* getClientProvider;
      const query = {
        status: Option.getOrUndefined(status),
        cursor: cursorValue,
        limit: limitValue,
      };
      if (all) {
        let nextCursor = cursorValue;
        for (;;) {
          const data = yield* Campaigns.list({ ...query, cursor: nextCursor }).pipe(
            client.provide,
            Effect.mapError((error) => toCliApiError("Could not list campaigns", error)),
          );
          for (const item of data.items) yield* printJsonLine(withoutSeries(item));
          if (data.nextCursor === null) return;
          nextCursor = data.nextCursor;
        }
      }
      const data = yield* Campaigns.list(query).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not list campaigns", error)),
      );
      if (isJsonLinesRequested()) {
        for (const item of data.items) yield* printJsonLine(withoutSeries(item));
        return;
      }
      if (json) return yield* printJson({ ...data, items: data.items.map(withoutSeries) });
      if (data.items.length === 0) {
        return yield* Console.log("No campaigns yet. Create one with `samva campaigns create`.");
      }
      for (const campaign of data.items) {
        yield* printFields([
          ["ID", campaign.id],
          ["Name", campaign.name],
          ["Channel", campaign.channel],
          ["Definition", campaign.definition.state],
        ]);
        yield* Console.log("");
      }
      if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const printCampaign = (campaign: {
  readonly id: string;
  readonly name: string;
  readonly channel: string;
  readonly definition: { readonly state: string };
  readonly audience: {
    readonly topicId: string;
    readonly includeTags?: ReadonlyArray<string> | null | undefined;
    readonly excludeTags?: ReadonlyArray<string> | null | undefined;
    readonly contactIds?: ReadonlyArray<string> | null | undefined;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}) =>
  printFields([
    ["ID", campaign.id],
    ["Name", campaign.name],
    ["Channel", campaign.channel],
    ["Definition", campaign.definition.state],
    ["Topic", campaign.audience.topicId],
    ["Include tags", (campaign.audience.includeTags ?? []).join(", ")],
    ["Exclude tags", (campaign.audience.excludeTags ?? []).join(", ")],
    ["Contact ids", (campaign.audience.contactIds ?? []).join(", ")],
    ["Created", campaign.createdAt],
    ["Updated", campaign.updatedAt],
  ]);

const get = Command.make("get", { id: Argument.String("id"), json: jsonFlag }).pipe(
  Command.withDescription("Show a campaign by id"),
  Command.withExamples([{ command: "samva campaigns get camp_abc123" }]),
  Command.withHandler(({ id, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Campaigns.get({ id }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not fetch campaign", error)),
      );
      if (json) return yield* printJson(data);
      yield* printCampaign(data);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const update = Command.make("update", {
  id: Argument.String("id"),
  name: Flag.String("name").pipe(Flag.withDescription("New campaign name"), Flag.optional),
  subject: subjectFlag,
  preheader: preheaderFlag,
  issuePath: issuePathFlag,
  issueCommit: issueCommitFlag,
  html: htmlFlag,
  text: textFlag,
  templateId: templateIdFlag,
  publicationId: publicationIdFlag,
  inputContractId: inputContractIdFlag,
  templateSlug: templateSlugFlag,
  templateData: templateDataFlag,
  includeTags: includeTagsFlag,
  excludeTags: excludeTagsFlag,
  contactIds: contactIdsFlag,
  topicId: topicIdFlag,
  pageSize: pageSizeFlag,
  trackOpens: trackOpensFlag,
  trackClicks: trackClicksFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Update a draft campaign before its first run"),
  Command.withExamples([
    { command: 'samva campaigns update camp_abc123 --name "August launch"' },
    {
      command:
        "samva campaigns update camp_abc123 --template-slug august-launch --topic-id unsub_1234567890abcdef --include-tags newsletter",
      description: "Replace content and audience while the definition is still editable",
    },
  ]),
  Command.withHandler(
    ({
      id,
      name,
      subject,
      preheader,
      issuePath,
      issueCommit,
      html,
      text,
      templateId,
      publicationId,
      inputContractId,
      templateSlug,
      templateData,
      includeTags,
      excludeTags,
      contactIds,
      topicId,
      pageSize,
      trackOpens,
      trackClicks,
      json,
    }) =>
      Effect.gen(function* () {
        const issue = yield* resolveIssue(issuePath, issueCommit, [
          subject,
          preheader,
          html,
          text,
          templateId,
          templateSlug,
          publicationId,
          inputContractId,
        ]);
        const htmlValue = Option.getOrUndefined(html);
        const textValue = Option.getOrUndefined(text);
        const templateIdValue = Option.getOrUndefined(templateId);
        const reference = yield* resolveTemplateReference({
          templateId: templateIdValue,
          publicationId: Option.getOrUndefined(publicationId),
          inputContractId: Option.getOrUndefined(inputContractId),
        });
        const templateSlugValue = Option.getOrUndefined(templateSlug);
        if (templateIdValue && templateSlugValue) {
          return yield* new SamvaCliError({
            message: "Use either --template-id or --template-slug, not both.",
          });
        }
        const templateDataValue = yield* parseTemplateData(templateData);
        const templateRefValue = templateSlugValue ?? templateIdValue;
        const hasContentFlags =
          issue !== undefined ||
          Option.isSome(preheader) ||
          Option.isSome(subject) ||
          Boolean(htmlValue || textValue || templateRefValue) ||
          Option.isSome(templateData) ||
          Option.isSome(publicationId) ||
          Option.isSome(inputContractId) ||
          Option.isSome(trackOpens) ||
          Option.isSome(trackClicks);
        if (
          templateRefValue &&
          (Option.isSome(subject) || Option.isSome(preheader) || htmlValue || textValue)
        ) {
          return yield* new SamvaCliError({
            message:
              "Choose one content source: a template, or inline --subject with --html (and optional --text).",
          });
        }
        if (issue === undefined && hasContentFlags && !templateRefValue && Option.isNone(subject)) {
          return yield* new SamvaCliError({
            message: "Provide --subject with inline --html, or reference a published template.",
          });
        }
        if (issue === undefined && hasContentFlags && !templateRefValue && !htmlValue) {
          return yield* new SamvaCliError({
            message: "Provide --html for inline email; --text is an optional fallback.",
          });
        }

        const includeTagsValue = parseTagList(includeTags);
        const excludeTagsValue = parseTagList(excludeTags);
        const contactIdsValue = parseTagList(contactIds);
        const hasAudience =
          Option.isSome(topicId) ||
          includeTagsValue.length > 0 ||
          excludeTagsValue.length > 0 ||
          contactIdsValue.length > 0;
        const hasPolicy = Option.isSome(pageSize);
        const hasContent = hasContentFlags;
        const tracking =
          Option.isSome(trackOpens) || Option.isSome(trackClicks)
            ? {
                ...(Option.isSome(trackOpens) ? { opens: trackOpens.value === "on" } : {}),
                ...(Option.isSome(trackClicks) ? { clicks: trackClicks.value === "on" } : {}),
              }
            : undefined;
        if (hasAudience && Option.isNone(topicId)) {
          return yield* new SamvaCliError({
            message:
              "A replacement audience requires --topic-id; include/exclude tags and contact ids narrow it.",
          });
        }
        if (!Option.isSome(name) && !hasContent && !hasAudience && !hasPolicy) {
          return yield* new SamvaCliError({
            message: "Provide at least one field to update. Run `samva campaigns update --help`.",
          });
        }

        const payload: CampaignsUpdateRequestJson = {
          name: Option.getOrUndefined(name),
          content: hasContent
            ? {
                channel: "email",
                ...(issue === undefined ? {} : { issue }),
                email: {
                  subject: Option.getOrUndefined(subject),
                  preheader: Option.getOrUndefined(preheader),
                  html: htmlValue,
                  text: textValue,
                  templateId: templateIdValue,
                  ...reference,
                  templateSlug: templateSlugValue,
                  templateData: templateDataValue,
                  ...(tracking === undefined ? {} : { tracking }),
                },
              }
            : undefined,
          audience:
            hasAudience && Option.isSome(topicId)
              ? {
                  topicId: topicId.value,
                  includeTags: includeTagsValue.length > 0 ? includeTagsValue : undefined,
                  excludeTags: excludeTagsValue.length > 0 ? excludeTagsValue : undefined,
                  contactIds: contactIdsValue.length > 0 ? contactIdsValue : undefined,
                }
              : undefined,
          policy: hasPolicy
            ? {
                pageSize: Option.getOrUndefined(pageSize),
              }
            : undefined,
        };
        const client = yield* getClientProvider;
        const data = yield* Campaigns.update({ id, ...payload }).pipe(
          client.provide,
          Effect.mapError((error) => toCliApiError("Could not update campaign", error)),
        );
        if (json) return yield* printJson(data);
        yield* Effect.logInfo("Campaign updated. Definitions freeze after the first run.\n");
        yield* printCampaign(data);
      }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const archive = Command.make("archive", {
  id: Argument.String("id"),
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Archive a campaign"),
  Command.withExamples([
    { command: "samva campaigns archive camp_abc123 --dry-run" },
    { command: "samva campaigns archive camp_abc123 --yes" },
  ]),
  Command.withHandler(({ id, dryRun, yes, json }) =>
    Effect.gen(function* () {
      if (dryRun) {
        return yield* json
          ? printJson({ dryRun: true, action: "campaigns.archive", id })
          : Console.log(`[dry-run] Would archive campaign ${id}.`);
      }
      yield* confirmDestructive({
        yes,
        json,
        message: `Archive campaign ${id}? It will no longer be eligible to run.`,
        nonInteractiveMessage:
          "Campaign archival requires --yes in non-interactive mode. Preview with --dry-run.",
      });
      const client = yield* getClientProvider;
      const data = yield* Campaigns.archive({ id }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not archive campaign", error)),
      );
      if (json) return yield* printJson(data);
      yield* Effect.logInfo("Campaign archived.\n");
      yield* printFields([
        ["ID", data.id],
        ["Name", data.name],
        ["Definition", data.definition.state],
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const printRun = (
  run: {
    readonly id: string;
    readonly campaignId: string;
    readonly status: string;
    readonly scheduledFor: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
    readonly totalRecipients: number | string;
    readonly dispatchedCount: number | string;
    readonly failedCount: number | string;
    readonly skippedCount: number | string;
    readonly skippedReasons?: ReadonlyArray<{ readonly reason: string; readonly count: number }>;
    readonly failureReason: string | null;
    readonly pendingCount?: number;
    readonly estimatedCompletionAt?: string | null;
    readonly holdReason?: string | null;
    readonly holdUntil?: string | null;
    readonly capacityWarning?: string | null;
  },
  options: { readonly warning: boolean } = { warning: true },
) =>
  printFields([
    ["Run ID", run.id],
    ["Campaign", run.campaignId],
    ["Status", run.status],
    ["Scheduled for", run.scheduledFor],
    ["Started", run.startedAt],
    ["Completed", run.completedAt],
    ["Recipients", String(run.totalRecipients)],
    ["Dispatched", String(run.dispatchedCount)],
    ["Failed", String(run.failedCount)],
    ["Skipped", String(run.skippedCount)],
    [
      "Skipped by reason",
      (run.skippedReasons ?? []).map(({ reason, count }) => `${reason} ${count}`).join(", "),
    ],
    ["Failure", run.failureReason],
    ...campaignPacingFields(run, options),
  ]);

/**
 * The schedule-time capacity warning is advisory: it goes to stderr and never fails the command.
 * The pacing fields are optional until the SDK's pinned public document carries them.
 */
const warnCapacity = (run: { readonly id: string; readonly capacityWarning?: string | null }) =>
  run.capacityWarning ? Console.error(`Warning: ${run.capacityWarning}`) : Effect.void;

const compositionFlags = {
  topicId: Flag.String("topic-id").pipe(
    Flag.withDescription("Topic owning the issue and the campaign audience"),
  ),
  issuePath: issuePathFlag,
  issueCommit: issueCommitFlag,
  subject: subjectFlag,
  preheader: preheaderFlag,
  html: htmlFlag,
  text: textFlag,
  templateId: templateIdFlag,
  templateSlug: templateSlugFlag,
  templateData: templateDataFlag,
  publicationId: publicationIdFlag,
  inputContractId: inputContractIdFlag,
  contactId: Flag.String("contact-id").pipe(
    Flag.withDescription(
      "Optional contact for personalization; tests still send to your account email",
    ),
    Flag.optional,
  ),
  dryRun: dryRunFlag,
  json: jsonFlag,
};
const composition = (name: "preview" | "test") =>
  Command.make(name, compositionFlags).pipe(
    Command.withDescription(
      name === "preview"
        ? "Render draft campaign content without sending"
        : "Send one draft campaign email to your authenticated account email",
    ),
    Command.withExamples([
      {
        command: `samva campaigns ${name} --topic-id unsub_1234567890abcdef --issue-path issues/october.md --issue-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --json`,
      },
    ]),
    Command.withHandler(
      ({
        topicId,
        issuePath,
        issueCommit,
        subject,
        preheader,
        html,
        text,
        templateId,
        templateSlug,
        templateData,
        publicationId,
        inputContractId,
        contactId,
        dryRun,
        json,
      }) =>
        Effect.gen(function* () {
          const issue = yield* resolveIssue(issuePath, issueCommit, [
            subject,
            preheader,
            html,
            text,
            templateId,
            templateSlug,
            publicationId,
            inputContractId,
          ]);
          if (issue === undefined && Option.isSome(templateId) && Option.isSome(templateSlug))
            return yield* new CliUsageError({
              code: "mixed_templates",
              message: "Use either --template-id or --template-slug, not both.",
            });
          const hasTemplate = Option.isSome(templateId) || Option.isSome(templateSlug);
          if (hasTemplate && [subject, preheader, html, text].some(Option.isSome))
            return yield* new CliUsageError({
              code: "mixed_template_content",
              message: "Choose a template or inline --subject and --html.",
            });
          if (
            issue === undefined &&
            !hasTemplate &&
            (Option.isNone(subject) || Option.isNone(html))
          )
            return yield* new CliUsageError({
              code: "content_required",
              message:
                "Pass --issue-path with --issue-commit, a template, or inline --subject and --html.",
            });
          const reference = yield* resolveTemplateReference({
            templateId: Option.getOrUndefined(templateId),
            publicationId: Option.getOrUndefined(publicationId),
            inputContractId: Option.getOrUndefined(inputContractId),
          });
          const data = yield* parseTemplateData(templateData);
          const request = {
            audience: { topicId },
            content: {
              channel: "email" as const,
              ...(issue === undefined ? {} : { issue }),
              email: {
                subject: Option.getOrUndefined(subject),
                preheader: Option.getOrUndefined(preheader),
                html: Option.getOrUndefined(html),
                text: Option.getOrUndefined(text),
                templateId: Option.getOrUndefined(templateId),
                templateSlug: Option.getOrUndefined(templateSlug),
                ...reference,
                templateData: data,
              },
            },
            contactId: Option.getOrUndefined(contactId),
          };
          if (dryRun) {
            if (json)
              return yield* printJson({
                dryRun,
                action: name === "preview" ? "campaigns.preview" : "campaigns.sendTest",
                request,
              });
            yield* printFields([
              ["Action", name === "preview" ? "Preview campaign content" : "Send campaign test"],
              ["Topic", topicId],
              ["Issue", issue?.path],
              ["Saved version", issue?.commit],
            ]);
            return yield* Console.log(
              `\nPayload:\n${truncateForDisplay(JSON.stringify(request, null, 2))}`,
            );
          }
          const client = yield* getClientProvider;
          if (name === "preview") {
            const result = yield* Campaigns.preview(request).pipe(
              client.provide,
              Effect.mapError((error) =>
                toCliApiError("Could not preview campaign content", error),
              ),
            );
            if (json) return yield* printJson(result);
            yield* printFields([
              ["Subject", result.subject],
              ["Preheader", result.preheader],
            ]);
            return yield* Console.log(`\n${result.text}`);
          }
          const result = yield* Campaigns.sendTest(request).pipe(
            client.provide,
            Effect.mapError((error) => toCliApiError("Could not send campaign test", error)),
          );
          if (json) return yield* printJson(result);
          yield* printFields([["Message ID", result.id]]);
          yield* Console.log(`Check delivery: samva messages get ${result.id}`);
        }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
    ),
  );
const preview = composition("preview");
const sendTest = composition("test");

const runCreate = Command.make("create", {
  campaignId: Argument.String("campaignId"),
  at: atFlag,
  idempotencyKey: idempotencyKeyFlag,
  dryRun: dryRunFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create a run for a campaign (starts immediately without --at)"),
  Command.withExamples([
    { command: "samva campaigns runs create camp_abc123", description: "Start now" },
    {
      command: "samva campaigns runs create camp_abc123 --at 2026-08-01T09:00:00Z",
      description: "Start at a future time",
    },
  ]),
  Command.withHandler(({ campaignId, at, idempotencyKey, dryRun, json }) =>
    Effect.gen(function* () {
      const atValue = Option.getOrUndefined(at);
      if (atValue !== undefined && !isAbsoluteInstant(atValue)) {
        return yield* new SamvaCliError({
          message:
            "--at must be an absolute ISO 8601 instant with Z or an offset, e.g. 2026-08-01T09:00:00Z.",
        });
      }
      const idempotencyKeyValue = Option.getOrUndefined(idempotencyKey);
      if (dryRun)
        return yield* json
          ? printJson({
              dryRun: true,
              action: "campaigns.runs.create",
              campaignId,
              scheduledFor: atValue,
              idempotencyKey: idempotencyKeyValue,
            })
          : Console.log(
              `[dry-run] Would create a run for campaign ${campaignId}${atValue ? ` at ${atValue}` : " now"}.`,
            );
      const client = yield* getClientProvider;
      const data = yield* Campaigns.scheduleRun(
        {
          id: campaignId,
          scheduledFor: atValue === undefined ? undefined : new Date(atValue),
        },
        { idempotencyKey: idempotencyKeyValue },
      ).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not schedule run", error)),
      );
      if (json) return yield* printJson(data);
      yield* Effect.logInfo("Run scheduled.\n");
      yield* printRun(data, { warning: false });
      yield* warnCapacity(data);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const runList = Command.make("list", {
  campaignId: Argument.String("campaignId"),
  status: runStatusFlag,
  cursor: cursorFlag,
  limit: limitFlag,
  all: allFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List runs for a campaign"),
  Command.withExamples([{ command: "samva campaigns runs list camp_abc123" }]),
  Command.withHandler(({ campaignId, status, cursor, limit, all, json }) =>
    Effect.gen(function* () {
      if (all && !isJsonLinesRequested())
        return yield* new CliUsageError({
          code: "all_requires_jsonl",
          message: "--all is an unbounded traversal and requires --jsonl.",
        });
      const cursorValue = Option.getOrUndefined(cursor);
      const limitValue = Option.getOrUndefined(limit);
      const client = yield* getClientProvider;
      const query = {
        id: campaignId,
        status: Option.getOrUndefined(status),
        cursor: cursorValue,
        limit: limitValue,
      };
      if (all) {
        let nextCursor = cursorValue;
        for (;;) {
          const data = yield* Campaigns.listRuns({ ...query, cursor: nextCursor }).pipe(
            client.provide,
            Effect.mapError((error) => toCliApiError("Could not list runs", error)),
          );
          for (const item of data.items) yield* printJsonLine(item);
          if (data.nextCursor === null) return;
          nextCursor = data.nextCursor;
        }
      }
      const data = yield* Campaigns.listRuns(query).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not list runs", error)),
      );
      if (isJsonLinesRequested()) {
        for (const item of data.items) yield* printJsonLine(item);
        return;
      }
      if (json) return yield* printJson(data);
      if (data.items.length === 0) {
        return yield* Console.log("No runs yet. Create one with `samva campaigns runs create`.");
      }
      for (const run of data.items) {
        yield* printFields([
          ["Run ID", run.id],
          ["Status", run.status],
          ["Scheduled for", run.scheduledFor],
          ["Dispatched", String(run.dispatchedCount)],
          ["Failed", String(run.failedCount)],
          ["Skipped", String(run.skippedCount)],
          [
            "Skipped by reason",
            run.skippedReasons.map(({ reason, count }) => `${reason} ${count}`).join(", "),
          ],
        ]);
        yield* Console.log("");
      }
      if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const runGet = Command.make("get", {
  campaignId: Argument.String("campaignId"),
  runId: Argument.String("runId"),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show a campaign run"),
  Command.withExamples([{ command: "samva campaigns runs get camp_abc123 crun_def456" }]),
  Command.withHandler(({ campaignId, runId, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Campaigns.getRun({ id: campaignId, runId }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not fetch run", error)),
      );
      if (json) return yield* printJson(data);
      yield* printRun(data);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const report = Command.make("report", {
  campaignId: Argument.String("campaignId"),
  runId: Argument.String("runId"),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show an email run's recipient report; opens and clicks are directional"),
  Command.withExamples([
    { command: "samva campaigns report camp_abc123 crun_def456" },
    { command: "samva campaigns report camp_abc123 crun_def456 --json" },
  ]),
  Command.withHandler(({ campaignId, runId, json }) =>
    Effect.gen(function* () {
      const client = yield* getClientProvider;
      const data = yield* Campaigns.getRunReport({ id: campaignId, runId }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not fetch run report", error)),
      );
      if (json) return yield* printJson(data);
      yield* printFields([
        ["Campaign", data.campaignId],
        ["Run", data.runId],
        ["Recipients", data.totalRecipients],
        ["Dispatched", data.dispatchedCount],
        ["Failed", data.failedCount],
        ["Skipped", data.skippedCount],
        ["Delivered", data.deliveredCount],
        ["Hard bounces", data.hardBounceCount],
        ["Soft bounces", data.softBounceCount],
        ["Complaints", data.complaintCount],
        ["Unique opens (directional)", data.engagement.uniqueOpens],
        ["Unique clicks (directional)", data.engagement.uniqueClicks],
        ["Replies", data.replyCount],
      ]);
      yield* Console.log("\nOpens and clicks are directional, with machine observations excluded.");
      for (const topic of data.unsubscribesByTopic) {
        yield* printFields([[`Unsubscribes · ${topic.topicId}`, topic.count]]);
      }
      for (const skipped of data.skippedReasons) {
        yield* printFields([[`Skipped · ${skipped.reason}`, skipped.count]]);
      }
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const runPause = Command.make("pause", {
  campaignId: Argument.String("campaignId"),
  runId: Argument.String("runId"),
  dryRun: dryRunFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Pause a running campaign run"),
  Command.withExamples([{ command: "samva campaigns runs pause camp_abc123 crun_def456" }]),
  Command.withHandler(({ campaignId, runId, dryRun, json }) =>
    Effect.gen(function* () {
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "campaigns.runs.pause", campaignId, runId })
          : Console.log(`[dry-run] Would pause campaign run ${runId}.`);
      const client = yield* getClientProvider;
      const data = yield* Campaigns.pauseRun({ id: campaignId, runId }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not pause run", error)),
      );
      if (json) return yield* printJson(data);
      yield* Effect.logInfo("Run paused.\n");
      yield* printRun(data.item);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const runResume = Command.make("resume", {
  campaignId: Argument.String("campaignId"),
  runId: Argument.String("runId"),
  dryRun: dryRunFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Resume a paused campaign run"),
  Command.withExamples([{ command: "samva campaigns runs resume camp_abc123 crun_def456" }]),
  Command.withHandler(({ campaignId, runId, dryRun, json }) =>
    Effect.gen(function* () {
      if (dryRun)
        return yield* json
          ? printJson({ dryRun: true, action: "campaigns.runs.resume", campaignId, runId })
          : Console.log(`[dry-run] Would resume campaign run ${runId}.`);
      const client = yield* getClientProvider;
      const data = yield* Campaigns.resumeRun({ id: campaignId, runId }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not resume run", error)),
      );
      if (json) return yield* printJson(data);
      yield* Effect.logInfo("Run resumed.\n");
      yield* printRun(data.item);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const runCancel = Command.make("cancel", {
  campaignId: Argument.String("campaignId"),
  runId: Argument.String("runId"),
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Cancel a campaign run (best effort once dispatch has started; terminal when scheduled)",
  ),
  Command.withExamples([
    { command: "samva campaigns runs cancel camp_abc123 crun_def456 --dry-run" },
    { command: "samva campaigns runs cancel camp_abc123 crun_def456 --yes" },
  ]),
  Command.withHandler(({ campaignId, runId, dryRun, yes, json }) =>
    Effect.gen(function* () {
      if (dryRun) {
        return yield* json
          ? printJson({ dryRun: true, action: "campaigns.runs.cancel", campaignId, runId })
          : Console.log(`[dry-run] Would cancel campaign run ${runId}.`);
      }
      yield* confirmDestructive({
        yes,
        json,
        message: `Cancel campaign run ${runId}? Dispatches already in progress may still complete.`,
        nonInteractiveMessage:
          "Campaign run cancellation requires --yes in non-interactive mode. Preview with --dry-run.",
      });
      const client = yield* getClientProvider;
      const data = yield* Campaigns.cancelRun({ id: campaignId, runId }).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not cancel run", error)),
      );
      if (json) return yield* printJson(data);
      yield* Effect.logInfo("Run cancelled.\n");
      yield* printRun(data.item);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const runRecipients = Command.make("recipients", {
  campaignId: Argument.String("campaignId"),
  runId: Argument.String("runId"),
  status: recipientStatusFlag,
  cursor: cursorFlag,
  limit: limitFlag,
  all: allFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List recipients for a campaign run"),
  Command.withExamples([
    { command: "samva campaigns runs recipients camp_abc123 crun_def456" },
    {
      command: "samva campaigns runs recipients camp_abc123 crun_def456 --status failed",
      description: "Only failed recipients",
    },
  ]),
  Command.withHandler(({ campaignId, runId, status, cursor, limit, all, json }) =>
    Effect.gen(function* () {
      if (all && !isJsonLinesRequested())
        return yield* new CliUsageError({
          code: "all_requires_jsonl",
          message: "--all is an unbounded traversal and requires --jsonl.",
        });
      const cursorValue = Option.getOrUndefined(cursor);
      const limitValue = Option.getOrUndefined(limit);
      const client = yield* getClientProvider;
      const query = {
        id: campaignId,
        runId,
        status: Option.getOrUndefined(status),
        cursor: cursorValue,
        limit: limitValue,
      };
      if (all) {
        let nextCursor = cursorValue;
        for (;;) {
          const data = yield* Campaigns.listRecipients({
            ...query,
            cursor: nextCursor,
          }).pipe(
            client.provide,
            Effect.mapError((error) => toCliApiError("Could not list recipients", error)),
          );
          for (const item of data.items) yield* printJsonLine(item);
          if (data.nextCursor === null) return;
          nextCursor = data.nextCursor;
        }
      }
      const data = yield* Campaigns.listRecipients(query).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not list recipients", error)),
      );
      if (isJsonLinesRequested()) {
        for (const item of data.items) yield* printJsonLine(item);
        return;
      }
      if (json) return yield* printJson(data);
      if (data.items.length === 0) {
        return yield* Console.log("No recipients for this run.");
      }
      for (const recipient of data.items) {
        yield* printFields([
          ["Contact", recipient.contactId],
          ["Status", recipient.status],
          ["Message ID", recipient.messageId],
          ["Skipped", recipient.skippedReason],
          ["Failure", recipient.failureReason],
        ]);
        yield* Console.log("");
      }
      if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const runsCommand = Command.make("runs").pipe(
  Command.withDescription("Manage campaign runs"),
  Command.withExamples([
    { command: "samva campaigns runs create camp_abc123", description: "Start a run now" },
    { command: "samva campaigns runs list camp_abc123", description: "List runs" },
  ]),
  Command.withSubcommands([
    runCreate,
    runList,
    runGet,
    runPause,
    runResume,
    runCancel,
    runRecipients,
  ]),
);

export const campaignsCommand = Command.make("campaigns").pipe(
  Command.withDescription("Create and operate audience-targeted campaigns"),
  Command.withExamples([
    {
      command:
        'samva campaigns create --topic-id unsub_1234567890abcdef --name "Spring launch" --subject Hi --html "<h1>Hi</h1>" --include-tags newsletter',
      description: "Create a campaign",
    },
    { command: "samva campaigns runs create camp_abc123", description: "Create a run" },
  ]),
  Command.withSubcommands([
    create,
    list,
    get,
    update,
    archive,
    preview,
    sendTest,
    report,
    runsCommand,
  ]),
);
