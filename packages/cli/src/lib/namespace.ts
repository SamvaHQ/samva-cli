import { NamespaceId } from "@samva/core/shared/base";
import * as Flag from "effect/cli/Flag";
import * as Option from "effect/Option";

/** `--namespace <id>`: lists filter to one namespace, creates place the resource in it. */
export const namespaceFlag = (what: "list" | "create") =>
  Flag.String("namespace").pipe(
    Flag.withSchema(NamespaceId),
    Flag.withDescription(
      what === "list"
        ? "Only resources in this namespace (ns_...)"
        : "Place the resource in this namespace (ns_...); omit for organization level",
    ),
    Flag.optional,
  );

/** The `namespaceId` field of a request, present only when the flag was given. */
export const namespaceField = (namespace: Option.Option<NamespaceId>) =>
  Option.match(namespace, {
    onNone: () => ({}),
    onSome: (namespaceId) => ({ namespaceId }),
  });

/**
 * Whether an existing resource found after a conflict is the one this request would have
 * created. A request that names a namespace wants the resource there. Without `--namespace`, the
 * API places it by the credential (a namespace-scoped key's namespace) and, for a sender, by its
 * domain, so any existing placement can be the request's own.
 */
export const placedAsRequested = (
  namespace: Option.Option<NamespaceId>,
  existing: NamespaceId | null,
) => Option.isNone(namespace) || existing === namespace.value;

/** Where a resource sits, for a refusal that names it. */
export const placementLabel = (namespaceId: NamespaceId | null) =>
  namespaceId === null ? "organization level" : `namespace ${namespaceId}`;
