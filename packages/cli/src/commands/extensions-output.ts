import type {
  Extension,
  ExtensionInstallation,
  ExtensionInstallationSummary,
  ExtensionManifest,
  ExtensionRunSummary,
  ExtensionVersionSummary,
} from "@samva/core/mailboxes/extension";
import { Console, Effect } from "effect";
import type * as ExtensionInstallations from "samva/effect/extension-installations";
import type * as Extensions from "samva/effect/extensions";

import { printFields } from "../lib/output";

type PublishedVersion = Effect.Success<ReturnType<typeof Extensions.getVersion>>;

export const printManifest = (
  item: typeof ExtensionManifest.Encoded | PublishedVersion["manifest"],
) =>
  printFields([
    ["Extension", `${item.name}@${item.version}`],
    ["Display name", item.displayName],
    ["Description", item.description === null ? "None" : item.description],
    ["Runtime", item.runtime],
    ["Events", item.events.join(", ")],
    ["Permissions", item.permissions.join(", ")],
  ]);

export const printExtension = (item: typeof Extension.Encoded) =>
  Effect.gen(function* () {
    yield* Console.log(`${item.displayName} (${item.name})`);
    yield* printFields([
      ["Extension ID", item.id],
      ["Description", item.description ?? "None"],
      ["Runtime", item.runtime],
      ["Latest version", `${item.latestVersion.version} (${item.latestVersion.id})`],
      ["Created", item.createdAt],
      ["Updated", item.updatedAt],
    ]);
  });

export const printVersionSummary = (item: typeof ExtensionVersionSummary.Encoded) =>
  printFields([
    ["Version", `${item.version} (${item.id})`],
    ["Runtime", item.runtime],
    ["Published", item.publishedAt],
    ["Bundle", item.bundle === null ? "None" : `${item.bundle.sizeBytes} bytes`],
    ["SHA256", item.bundle?.sha256],
  ]);

export const printVersion = (item: PublishedVersion) =>
  Effect.gen(function* () {
    yield* printVersionSummary(item);
    yield* Console.log("Manifest");
    yield* printManifest(item.manifest);
  });

export const printInstallationSummary = (item: typeof ExtensionInstallationSummary.Encoded) =>
  Effect.gen(function* () {
    yield* Console.log(`${item.displayName} (${item.name}) — ${item.status}`);
    yield* printFields([
      ["Installation", item.id],
      ["Extension ID", item.extensionId],
      ["Version", `${item.version.version} (${item.version.id})`],
      ["Runtime", item.runtime],
      ["Created", item.createdAt],
    ]);
  });

export const printInstallation = (item: typeof ExtensionInstallation.Encoded) =>
  Effect.gen(function* () {
    yield* printInstallationSummary(item);
    yield* Console.log("Access and delivery");
    yield* printFields([
      ["Events", item.events.join(", ") || "None"],
      ["Permissions", item.permissions.join(", ") || "None"],
      ["Send mode", item.sendMode],
      [
        "Mailboxes",
        item.scope.mailboxIds === null
          ? "All accessible mailboxes"
          : item.scope.mailboxIds.join(", ") || "None",
      ],
      ["Namespace", item.scope.namespaceId ?? "All namespaces"],
      ["Webhook", item.webhook?.url ?? "None"],
      ["Webhook endpoint", item.webhook?.endpointId],
      ["Updated", item.updatedAt],
      ["Disabled", item.disabledAt ?? "No"],
    ]);
  });

export const printRunSummary = (item: typeof ExtensionRunSummary.Encoded) =>
  Effect.gen(function* () {
    yield* Console.log(`${item.id}: ${item.outcome}`);
    yield* printFields([
      ["Event", item.eventId],
      ["Type", item.eventType],
      ["Attempt", item.attempt],
      ["Started", item.startedAt],
      ["Duration (ms)", item.durationMs],
      ["Error", item.error ?? "None"],
    ]);
  });

export const printUpgrade = (
  result: Effect.Success<ReturnType<typeof ExtensionInstallations.upgrade>>,
) =>
  Effect.gen(function* () {
    yield* Console.log(
      result.dryRun
        ? "Upgrade preview; no changes made. Installation details below show its current state."
        : result.versionChange === null
          ? "Installation already uses the selected version; no changes made."
          : "Installation upgraded.",
    );
    yield* printFields([
      ["From version", `${result.fromVersion.version} (${result.fromVersion.id})`],
      ["To version", `${result.toVersion.version} (${result.toVersion.id})`],
      ["Added grants", result.permissionDiff.added.join(", ") || "None"],
      ["Removed grants", result.permissionDiff.removed.join(", ") || "None"],
    ]);
    yield* printInstallation(result.installation);
    if (result.versionChange !== null) {
      yield* Console.log("Version change");
      yield* printFields([
        ["Change ID", result.versionChange.id],
        ["Organization", result.versionChange.organizationId],
        ["Changed by", result.versionChange.changedBy],
        ["Changed at", result.versionChange.changedAt],
      ]);
    }
  });
