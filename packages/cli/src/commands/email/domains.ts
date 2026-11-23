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
    shared: Flag.Literals("shared", ["true", "false"]).pipe(
      Flag.withDescription("Filter domains shared with every namespace"),
      Flag.optional,
    ),
    all: Flag.Boolean("all").pipe(
      Flag.withDescription("Traverse every page (requires --jsonl)"),
      Flag.withDefault(false),
    ),
    json: jsonFlag,
  },
  {
    mapInput: ({ cursor, limit, namespace, shared }) => ({
      cursor: Option.getOrUndefined(cursor),
      limit: Option.getOrUndefined(limit),
      ...namespaceField(namespace),
      ...Option.match(shared, {
        onNone: () => ({}),
        onSome: (value) => ({ shared: value === "true" }),
      }),
    }),
    call: (request) => Email.listDomains(request),
    failure: "Could not list domains",
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
            "No domains yet. Add one with `samva email domains add --domain example.com`.",
          );
        }
        for (const domain of data.items) {
          yield* printFields([
            ["Domain", domain.domain],
            ["Phase", domain.phase],
            ["Default", domain.isDefault ? "yes" : "no"],
            ["Namespace", domain.namespaceId ?? "organization"],
            ["Shared", domain.shared ? "yes" : "no"],
            ["ID", domain.id],
          ]);
          yield* Console.log("");
        }
        if (data.nextCursor !== null) yield* printFields([["Next cursor", data.nextCursor]]);
      }),
  },
).pipe(
  Command.withDescription("List email sending domains"),
  Command.withExamples([
    { command: "samva email domains list" },
    { command: "samva email domains list --json" },
    { command: "samva email domains list --shared true --json" },
  ]),
);

const add = Command.make("add", {
  domain: Flag.String("domain").pipe(Flag.withDescription("Domain to add, e.g. example.com")),
  namespace: namespaceFlag("create"),
  shared: Flag.Boolean("shared").pipe(
    Flag.withDescription("Share this organization-level domain with every namespace"),
    Flag.withDefault(false),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Print the planned change without calling the API"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Add an email sending domain"),
  Command.withExamples([
    {
      command: "samva email domains add --domain example.com --dry-run",
      description: "Preview add",
    },
    {
      command: "samva email domains add --domain example.com",
      description: "Apply domain add",
    },
    { command: "samva email domains add --domain example.com --shared" },
    {
      command: "samva email domains add --domain customer.example --namespace ns_7q2xk9mvt4znw8rh",
      description: "Add the domain to a namespace",
    },
  ]),
  Command.withHandler(({ domain, namespace, shared, dryRun, json }) =>
    Effect.gen(function* () {
      if (shared && Option.isSome(namespace))
        return yield* new CliUsageError({
          code: "shared_namespace_conflict",
          message: "--shared requires an organization-level domain; omit --namespace.",
        });
      const request = { domain, ...namespaceField(namespace), ...(shared ? { shared: true } : {}) };
      if (dryRun) {
        if (json)
          return yield* printJson({
            dryRun: true,
            action: "email.domains.add",
            ...request,
          });
        return yield* Console.log(`[dry-run] Would add domain "${domain}".`);
      }

      const client = yield* getClientProvider;
      yield* Effect.matchEffect(Email.addDomain(request).pipe(client.provide), {
        onFailure: (error) => {
          const conflict = getConflictError(error);
          if (!conflict) {
            return Effect.fail(toCliApiError("Could not add domain", error));
          }

          const findExisting = Effect.gen(function* () {
            if (typeof conflict.id === "string" && conflict.id.length > 0) {
              const fetched = yield* Email.getDomainById({ id: conflict.id }).pipe(
                client.provide,
                Effect.catchTag("ResourceNotFoundError", () => Effect.void),
                Effect.mapError((lookupError) =>
                  toCliApiError("Domain already exists but could not fetch it by id", lookupError),
                ),
              );
              if (fetched) return fetched;
            }

            let cursor: string | undefined;
            while (true) {
              const listed = yield* Email.listDomains({ cursor, limit: 100 }).pipe(
                client.provide,
                Effect.mapError((listError) =>
                  toCliApiError(
                    "Domain may already exist but could not verify idempotently",
                    listError,
                  ),
                ),
              );
              const existing = listed.items.find((item) => item.domain === domain);
              if (existing) return existing;
              if (listed.nextCursor === null) break;
              cursor = listed.nextCursor;
            }

            return yield* toCliApiError("Could not add domain", error);
          });

          return Effect.gen(function* () {
            const existing = yield* findExisting;
            // Only the resource this request would have created is an idempotent success.
            if (shared && !existing.shared)
              return yield* toCliApiError(
                `Domain "${existing.domain}" already exists without sharing; share it with \`samva email domains update ${existing.id} --shared true\``,
                error,
              );
            if (!placedAsRequested(namespace, existing.namespaceId))
              return yield* toCliApiError(
                `Domain "${existing.domain}" already exists at ${placementLabel(existing.namespaceId)}; move it with \`samva namespaces assign\``,
                error,
              );
            if (json) yield* printJson({ ...existing, idempotent: true });
            else
              yield* Effect.logWarning(
                `Domain "${existing.domain}" already exists (phase: ${existing.phase}).`,
              );
          });
        },
        onSuccess: (data) =>
          Effect.gen(function* () {
            if (json) return yield* printJson(data);
            yield* Effect.logInfo(
              `Domain "${data.domain}" staged (phase: ${data.phase}). Add these DNS records:\n`,
            );
            for (const record of data.dnsRecords) {
              yield* printFields([
                ["Type", record.type],
                ["Name", record.name],
                ["Value", record.value],
                ["TTL", record.ttl],
                ["Priority", record.priority],
              ]);
              yield* Console.log("");
            }
            yield* Effect.logInfo(`Then verify:  samva email domains check ${data.id}`);
          }),
      });
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);

const update = deriveOverride(
  "update",
  {
    id: Argument.String("id").pipe(Argument.withDescription("Organization-level domain id")),
    shared: Flag.Literals("shared", ["true", "false"]).pipe(
      Flag.withDescription("Share or unshare this domain with every namespace"),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Print the planned change without calling the API"),
      Flag.withDefault(false),
    ),
    json: jsonFlag,
  },
  {
    mapInput: ({ id, shared }) => ({ id, shared: shared === "true" }),
    call: (request) => Email.updateDomainConfig(request),
    failure: "Could not update domain sharing",
    preview: {
      data: (request) => ({ dryRun: true, action: "email.domains.update", ...request }),
      render: (request) =>
        Console.log(
          `[dry-run] Would ${request.shared ? "share" : "unshare"} domain ${request.id}.`,
        ),
    },
    render: (_data, _input, request) =>
      Console.log(`Domain ${request.id} is ${request.shared ? "shared" : "unshared"}.`),
  },
).pipe(
  Command.withDescription("Change whether an organization-level domain is shared"),
  Command.withExamples([
    { command: "samva email domains update dom_abc123 --shared true" },
    { command: "samva email domains update dom_abc123 --shared false --dry-run" },
  ]),
);

const check = deriveOverride(
  "check",
  {
    id: Argument.String("id").pipe(Argument.withDescription("Domain id to check")),
    json: jsonFlag,
  },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => Email.advanceDomainVerification(request),
    failure: "Could not check domain",
    render: (data) =>
      printFields([
        ["Domain", data.domain],
        ["Phase", data.phase],
        ["Last checked", data.checkedAt],
        ["Next check", data.nextCheckAt],
        ["Failure", data.failure?.message],
        ["Provider setup", data.provisioning.status],
        // Only worth printing once a redrive has happened: on the first attempt
        // it is always 1 and says nothing.
        ["Setup attempt", data.provisioning.revision > 1 ? data.provisioning.revision : undefined],
        ["Health reason", data.health.reason],
        ["Action owner", data.health.actionOwner],
        ["Action", data.health.action],
        ["Freshness", data.health.freshness],
        ["Observed", data.health.observedAt],
        ["Stale at", data.health.staleAt],
        ["Next retry", data.health.nextRetryAt],
        ["Sending", data.sending.status],
        ["Sending reason", data.sending.reason],
        ["Sending action owner", data.sending.actionOwner],
        ["Sending action", data.sending.action],
        ["Sending freshness", data.sending.freshness],
        ["DMARC", data.dmarc.status],
        ["DMARC policy", data.dmarc.effectivePolicy],
        ["DMARC guidance", data.dmarc.guidance],
        ["Rotation", data.rotation?.phase],
        ["Rotation selector", data.rotation?.selector],
      ]),
  },
).pipe(
  Command.withDescription(
    "Start a check of an email domain's DNS and provider verification, and read its current status",
  ),
  Command.withExamples([
    {
      command: "samva email domains check dom_abc123",
      description: "Check domain verification now",
    },
  ]),
);

const rotateDkim = deriveOverride(
  "rotate-dkim",
  {
    id: Argument.String("id").pipe(Argument.withDescription("Organization-owned domain id")),
    idempotencyKey: Flag.String("idempotency-key").pipe(
      Flag.withDescription("Stable key for this rotation; reuse the same key when retrying"),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Preview staging without calling the API"),
      Flag.withDefault(false),
    ),
    json: jsonFlag,
  },
  {
    prepare: ({ id, idempotencyKey }) =>
      idempotencyKey.length < 1 || idempotencyKey.length > 255
        ? Effect.fail(
            new CliUsageError({
              code: "invalid_idempotency_key",
              message:
                "--idempotency-key must contain between 1 and 255 characters. Example: samva email domains rotate-dkim dom_abc123 --idempotency-key rotation-2026-09",
            }),
          )
        : Effect.succeed({ id, idempotencyKey }),
    call: (request) =>
      Email.rotateDomainDkim({ id: request.id }, { idempotencyKey: request.idempotencyKey }),
    failure: "Could not stage DKIM rotation",
    preview: {
      data: (request) => ({
        dryRun: true,
        action: "email.domains.rotate-dkim",
        id: request.id,
        idempotencyKey: request.idempotencyKey,
      }),
      render: (request) =>
        Console.log(
          `[dry-run] Would stage a new DKIM selector for ${request.id}. The former DNS record must remain published.`,
        ),
    },
    render: (data, _input, request) =>
      Effect.gen(function* () {
        yield* printFields([
          ["Rotation", data.id],
          ["Domain ID", data.domainId],
          ["Phase", data.phase],
          ["Selector", data.selector],
        ]);
        yield* Console.log("Publish this DKIM DNS record:");
        yield* printFields([
          ["Type", data.record.type],
          ["Name", data.record.name],
          ["Value", data.record.value],
          ["TTL", data.record.ttl],
        ]);
        yield* Console.log("Keep this former DKIM DNS record published:");
        yield* printFields([
          ["Type", data.formerRecord.type],
          ["Name", data.formerRecord.name],
          ["Value", data.formerRecord.value],
          ["Minimum retain until", data.minimumRetainUntil],
        ]);
        yield* Console.log(
          "The minimum retention date does not authorize deletion. Retirement requires separate approval and verification that at least two actual former-record TTLs have elapsed.",
        );
        yield* Console.log(
          `After DNS publication, advance verification: samva email domains check ${request.id}`,
        );
      }),
  },
).pipe(
  Command.withDescription(
    "Stage a new DKIM selector for DNS publication; retain the former record",
  ),
  Command.withExamples([
    {
      command:
        "samva email domains rotate-dkim dom_abc123 --idempotency-key rotation-2026-09 --dry-run",
    },
    {
      command:
        "samva email domains rotate-dkim dom_abc123 --idempotency-key rotation-2026-09 --json",
    },
  ]),
);

const remove = deriveOverride(
  "remove",
  {
    id: Argument.String("id").pipe(Argument.withDescription("Domain id to permanently remove")),
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
    call: (request) => Email.removeDomain(request),
    failure: "Could not remove domain",
    preview: {
      data: (request) => ({ dryRun: true, action: "email.domains.remove", id: request.id }),
      render: (request) => Console.log(`[dry-run] Would permanently remove domain ${request.id}.`),
    },
    confirmation: (request) => ({
      message: `Permanently remove domain ${request.id}?`,
      nonInteractiveMessage:
        "Permanent domain deletion requires --yes in non-interactive mode. Preview with --dry-run.",
    }),
    render: (_data, _input, request) => Console.log(`Removed domain ${request.id}.`),
  },
).pipe(
  Command.withDescription("Permanently remove an email sending domain"),
  Command.withExamples([
    { command: "samva email domains remove dom_abc123 --dry-run" },
    { command: "samva email domains remove dom_abc123 --yes" },
  ]),
);

const setDefault = deriveOverride(
  "set-default",
  {
    id: Argument.String("id").pipe(Argument.withDescription("Domain id to make the default")),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Print the planned change without calling the API"),
      Flag.withDefault(false),
    ),
    json: jsonFlag,
  },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => Email.setDefaultDomain(request),
    failure: "Could not set the default domain",
    preview: {
      data: (request) => ({ dryRun: true, action: "email.domains.set-default", id: request.id }),
      render: (request) =>
        Console.log(`[dry-run] Would make domain ${request.id} the default domain.`),
    },
    render: (_data, _input, request) =>
      Console.log(`Domain ${request.id} is now the default domain.`),
  },
).pipe(
  Command.withDescription("Make a verified domain the organization's default sending domain"),
  Command.withExamples([
    { command: "samva email domains set-default dom_abc123 --dry-run" },
    { command: "samva email domains set-default dom_abc123" },
  ]),
);

type CustomTrackingResult = Effect.Success<ReturnType<typeof Email.getCustomTracking>>;

const printCustomTracking = (data: CustomTrackingResult) =>
  Effect.gen(function* () {
    if (!data.enabled || data.customTracking === null) {
      return yield* Console.log("Custom tracking is not enabled for this domain.");
    }
    const custom = data.customTracking;
    yield* printFields([
      ["Status", custom.status],
      ["Host", custom.hostname],
      ["Region", custom.region],
      ["Certificate", custom.sslStatus ?? "pending"],
      ["CAA blocked", custom.caaBlocked ? "yes" : "no"],
      ["Reason", custom.certificate?.reason.message],
      ["Last checked", custom.certificate?.lastCheckedAt],
      ["Next check", custom.certificate?.nextCheckAt],
    ]);
    yield* Console.log("\nCreate these DNS records:");
    for (const record of [custom.dnsRecords.tracking, custom.dnsRecords.dcvDelegation]) {
      if (record === null) continue;
      yield* printFields([
        ["Type", record.type],
        ["Name", record.name],
        ["Value", record.value],
      ]);
      yield* Console.log("");
    }
  });

const customEnable = deriveOverride(
  "enable",
  {
    id: Argument.String("id").pipe(
      Argument.withDescription("Domain id to enable custom tracking for"),
    ),
    label: Flag.String("label").pipe(
      Flag.withDescription("First-level label under the parent domain (default: track)"),
      Flag.optional,
    ),
    parent: Flag.String("parent").pipe(
      Flag.withDescription("Parent domain for the tracking host (default: sending domain)"),
      Flag.optional,
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Print the planned change without calling the API"),
      Flag.withDefault(false),
    ),
    json: jsonFlag,
  },
  {
    mapInput: ({ id, label, parent }) => {
      const chosenLabel = Option.getOrUndefined(label);
      const parentDomain = Option.getOrUndefined(parent);
      return {
        id,
        ...(chosenLabel === undefined ? {} : { label: chosenLabel }),
        ...(parentDomain === undefined ? {} : { parentDomain }),
      };
    },
    call: (request) => Email.enableCustomTracking(request),
    failure: "Could not enable custom tracking",
    preview: {
      data: (request) => ({
        dryRun: true,
        action: "email.domains.custom-tracking.enable",
        id: request.id,
        label: request.label,
        parentDomain: request.parentDomain,
      }),
      render: (request) =>
        Console.log(
          `[dry-run] Would enable custom tracking for ${request.id}${request.parentDomain === undefined ? "" : ` under ${request.parentDomain}`}.`,
        ),
    },
    render: (data) => printCustomTracking(data),
  },
).pipe(
  Command.withDescription("Enable a custom tracking domain"),
  Command.withExamples([
    { command: "samva email domains custom-tracking enable dom_abc123" },
    { command: "samva email domains custom-tracking enable dom_abc123 --label links" },
    { command: "samva email domains custom-tracking enable dom_abc123 --parent acme.com" },
  ]),
);

const customStatus = deriveOverride(
  "status",
  {
    id: Argument.String("id").pipe(Argument.withDescription("Domain id to inspect")),
    json: jsonFlag,
  },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => Email.getCustomTracking(request),
    failure: "Could not get custom tracking status",
    render: (data) => printCustomTracking(data),
  },
).pipe(
  Command.withDescription("Show a domain's custom tracking status"),
  Command.withExamples([{ command: "samva email domains custom-tracking status dom_abc123" }]),
);

const customRecheck = deriveOverride(
  "recheck",
  {
    id: Argument.String("id").pipe(Argument.withDescription("Domain id to recheck")),
    json: jsonFlag,
  },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => Email.recheckCustomTracking(request),
    failure: "Could not recheck custom tracking",
    render: (data) => printCustomTracking(data),
  },
).pipe(
  Command.withDescription(
    "Check a domain's custom tracking certificate now instead of waiting for the next scheduled check",
  ),
  Command.withExamples([{ command: "samva email domains custom-tracking recheck dom_abc123" }]),
);

const customDisable = deriveOverride(
  "disable",
  {
    id: Argument.String("id").pipe(
      Argument.withDescription("Domain id to disable custom tracking for"),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Print the teardown plan without calling the API"),
      Flag.withDefault(false),
    ),
    yes: Flag.Boolean("yes").pipe(
      Flag.withDescription("Confirm teardown (required for non-interactive use)"),
      Flag.withDefault(false),
    ),
    json: jsonFlag,
  },
  {
    mapInput: ({ id }) => ({ id }),
    call: (request) => Email.disableCustomTracking(request),
    failure: "Could not disable custom tracking",
    preview: {
      data: (request) => ({
        dryRun: true,
        action: "email.domains.custom-tracking.disable",
        id: request.id,
      }),
      render: (request) =>
        Console.log(`[dry-run] Would disable custom tracking for ${request.id}.`),
    },
    confirmation: (request) => ({
      message: `Disable custom tracking for ${request.id}? Existing custom links in delivered mail will break.`,
      nonInteractiveMessage:
        "Custom tracking teardown requires --yes in non-interactive mode. Preview with --dry-run.",
    }),
    render: (_data, _input, request) => Console.log(`Disabled custom tracking for ${request.id}.`),
  },
).pipe(
  Command.withDescription("Disable and tear down a custom tracking domain"),
  Command.withExamples([
    { command: "samva email domains custom-tracking disable dom_abc123 --dry-run" },
    { command: "samva email domains custom-tracking disable dom_abc123 --yes" },
  ]),
);

const customTracking = Command.make("custom-tracking").pipe(
  Command.withDescription("Manage a domain's custom tracking (custom open/click subdomain)"),
  Command.withExamples([{ command: "samva email domains custom-tracking enable dom_abc123" }]),
  Command.withSubcommands([customEnable, customStatus, customRecheck, customDisable]),
);

export const domainsCommand = Command.make("domains").pipe(
  Command.withDescription("Manage email sending domains"),
  Command.withExamples([
    { command: "samva email domains list", description: "List configured domains" },
  ]),
  Command.withSubcommands([
    list,
    add,
    update,
    check,
    rotateDkim,
    setDefault,
    remove,
    customTracking,
  ]),
);
