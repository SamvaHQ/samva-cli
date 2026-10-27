import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as References from "effect/References";
import type * as Client from "samva/effect/client";
import * as Email from "samva/effect/email";
import * as Organizations from "samva/effect/organizations";

import { resolveExecutionContext } from "../../config/store";
import { formatApiError, SamvaCliError, toCliApiError } from "../../errors";
import { getClientProvider } from "../../lib/client";
import { getText } from "../../lib/http";
import { jsonFlag, printFields, printJson } from "../../lib/output";

type DoctorCheck = {
  readonly name: string;
  readonly status: "passed" | "failed" | "unavailable";
  readonly detail: string;
};

/** Surface the real failure text so a failed check is actionable, not uniform. */
const detailFromError = (error: unknown): string =>
  Predicate.isObject(error) &&
  Predicate.hasProperty(error, "message") &&
  typeof error["message"] === "string"
    ? error["message"]
    : "Read failed";

const check = <R>(
  name: string,
  run: Effect.Effect<string, unknown, R>,
): Effect.Effect<DoctorCheck, never, R> =>
  run.pipe(
    Effect.match({
      onFailure: (error): DoctorCheck => ({
        name,
        status: "failed",
        detail: detailFromError(error),
      }),
      onSuccess: (detail): DoctorCheck => ({ name, status: "passed", detail }),
    }),
  );

const reachability = (apiUrl: string) =>
  check(
    "API reachability",
    getText(`${apiUrl.replace(/\/+$/, "")}/v1/health/ping`).pipe(
      Effect.flatMap((response) =>
        response.ok
          ? Effect.succeed("Health endpoint responded")
          : Effect.fail(
              new SamvaCliError({ message: `Health endpoint returned ${response.status}` }),
            ),
      ),
    ),
  );

const orgAccess = check(
  "Organization permissions",
  getClientProvider.pipe(
    Effect.flatMap((client) =>
      Organizations.get().pipe(
        client.provide,
        Effect.map((organization) => `${organization.name} (${organization.slug})`),
        Effect.mapError((error) => toCliApiError("Organization read failed", error)),
      ),
    ),
  ),
);

/** The send fence's answer: a rejection fails, a review still in flight is informational. */
const sendReview = getClientProvider.pipe(
  Effect.flatMap((client) =>
    Email.getOnboardingReview().pipe(
      client.provide,
      Effect.map((review): DoctorCheck => ({
        name: "Send review",
        status: review.canSend
          ? "passed"
          : review.code === "review_rejected" || review.code === "identity_review_rejected"
            ? "failed"
            : "unavailable",
        detail: review.canSend
          ? `${review.decision}; trust tier ${review.trustTier}`
          : `${review.code}; next action: ${review.nextAction}`,
      })),
    ),
  ),
  Effect.catch((error) =>
    Effect.succeed<DoctorCheck>({
      name: "Send review",
      status: "failed",
      detail: formatApiError("Send review read failed", error),
    }),
  ),
);

/** Whether an identity a send can use exists now, read with the send path's own filters. */
const identityCount = (
  name: string,
  noun: string,
  read: Effect.Effect<{ readonly items: ReadonlyArray<unknown> }, unknown, Client.Service>,
) =>
  getClientProvider.pipe(
    Effect.flatMap((client) => client.provide(read)),
    Effect.map(({ items }): DoctorCheck => ({
      name,
      status: items.length > 0 ? "passed" : "unavailable",
      detail: items.length > 0 ? `At least one ${noun}` : `None ${noun}`,
    })),
    Effect.catch((error) =>
      Effect.succeed<DoctorCheck>({
        name,
        status: "failed",
        detail: formatApiError(`${name} read failed`, error),
      }),
    ),
  );

const domains = identityCount(
  "Sending domains",
  "sendable",
  Email.listDomains({ sendable: true, limit: 1 }),
);

const senders = identityCount(
  "Senders",
  "verified and active",
  Email.listSenders({ verificationStatus: "verified", isActive: true, limit: 1 }),
);

const domainVerificationReadback = getClientProvider.pipe(
  Effect.flatMap((client) =>
    Email.listDomains({ limit: 1 }).pipe(
      client.provide,
      Effect.mapError((error) => toCliApiError("Domain verification read failed", error)),
      Effect.flatMap((result) => {
        const domain = result.items[0];
        if (!domain) {
          return Effect.succeed<DoctorCheck>({
            name: "Domain verification readback",
            status: "unavailable",
            detail: "No sending domain configured",
          });
        }
        return Email.getDomainVerification({ id: domain.id }).pipe(
          client.provide,
          Effect.map((status): DoctorCheck => {
            const verification = status.phase;
            return {
              name: "Domain verification readback",
              status:
                verification === "ready"
                  ? "passed"
                  : verification === "failed"
                    ? "failed"
                    : "unavailable",
              detail: `${status.domain}: ${status.phase}`,
            };
          }),
          Effect.mapError((error) => toCliApiError("Domain verification read failed", error)),
        );
      }),
    ),
  ),
  Effect.catch((error) =>
    Effect.succeed<DoctorCheck>({
      name: "Domain verification readback",
      status: "failed",
      detail: detailFromError(error),
    }),
  ),
);

export const doctorCommand = Command.make("doctor", { json: jsonFlag }).pipe(
  Command.withDescription("Read local configuration and remote email state"),
  Command.withExamples([{ command: "samva email doctor --json" }]),
  Command.withHandler(({ json }) =>
    Effect.gen(function* () {
      const context = yield* resolveExecutionContext;
      const authSource = context.apiKey
        ? "SAMVA_API_KEY"
        : context.credentials
          ? "stored OAuth credential"
          : "none";
      const [reachable, org, review, domainCount, senderCount, verification] = yield* Effect.all(
        [
          reachability(context.apiUrl),
          orgAccess,
          sendReview,
          domains,
          senders,
          domainVerificationReadback,
        ],
        { concurrency: "unbounded" },
      );
      const checks: ReadonlyArray<DoctorCheck> = [
        reachable,
        org,
        review,
        domainCount,
        senderCount,
        verification,
      ];
      const ok = checks.every((result) => result.status !== "failed");
      const payload = {
        schemaVersion: 1,
        mode: "read-only",
        ok,
        // The hosted MCP's email_check_readiness answer: the send fence admits a
        // production send and at least one identity can carry it.
        readyToSend:
          review.status === "passed" &&
          (domainCount.status === "passed" || senderCount.status === "passed"),
        limitations:
          "Reads the send fence and identity lists only. It does not send, mutate, replay fixtures, or check DNS itself.",
        resolved: {
          profile: context.profile,
          apiUrl: context.apiUrl,
          authSource,
          organization: context.orgSlug ?? null,
        },
        checks,
      };
      // Any failed check exits 1 while still emitting the full report, so an
      // agent gets both the honest exit code and the payload. `unavailable`
      // (e.g. no domain configured) is informational, not a failure.
      if (!ok) yield* Effect.sync(() => void (process.exitCode = 1));
      if (json) return yield* printJson(payload);
      yield* printFields([
        ["Profile", payload.resolved.profile],
        ["API", payload.resolved.apiUrl],
        ["Auth source", payload.resolved.authSource],
        ["Organization", payload.resolved.organization],
        ["Ready to send", payload.readyToSend ? "yes" : "no"],
      ]);
      yield* Console.log("\nRead-only checks:");
      for (const result of checks) {
        const glyph =
          result.status === "passed" ? "✓" : result.status === "unavailable" ? "!" : "✗";
        yield* Console.log(`${glyph} ${result.name}: ${result.detail}`);
      }
      yield* Console.log(`\n${payload.limitations}`);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
