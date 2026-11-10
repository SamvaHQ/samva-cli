import { InviteMemberPayload } from "@samva/contracts/organizations/group";
import { EmailAddressString, NamespaceId } from "@samva/core/shared/base";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Organizations from "samva/effect/organizations";

import { toCliApiError } from "../errors";
import { getClientProvider } from "../lib/client";
import { jsonFlag, printFields, printJson } from "../lib/output";

export const orgInviteCommand = Command.make("invite", {
  email: Argument.String("email").pipe(Argument.withSchema(EmailAddressString)),
  role: Flag.Literals("role", InviteMemberPayload.fields.role.literals).pipe(
    Flag.withDescription("member, admin, or mail_user"),
    Flag.withDefault("member"),
  ),
  mailboxAddress: Flag.String("mailbox-address").pipe(
    Flag.withSchema(EmailAddressString),
    Flag.withDescription("Personal mailbox address on a domain available to the member"),
  ),
  namespace: Flag.String("namespace").pipe(
    Flag.withSchema(NamespaceId),
    Flag.withDescription("Restrict the member to this namespace (ns_...)"),
    Flag.optional,
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Print the invitation without sending it"),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Invite a teammate, optionally restricted to one namespace"),
  Command.withExamples([
    {
      command:
        "samva org invite ada@example.com --mailbox-address ada@acme.example --namespace ns_1234567890123456 --role member",
      description: "Invite a teammate into one namespace",
    },
  ]),
  Command.withHandler(({ email, role, mailboxAddress, namespace, dryRun, json }) =>
    Effect.gen(function* () {
      const payload = {
        email,
        role,
        mailboxAddress,
        namespaceId: Option.getOrUndefined(namespace),
      };
      if (dryRun) {
        if (json) return yield* printJson({ dryRun: true, ...payload });
        return yield* printFields([
          ["Email", email],
          ["Role", role],
          ["Personal mailbox", mailboxAddress],
          ["Namespace", Option.getOrElse(namespace, () => "Whole organization")],
        ]);
      }
      const client = yield* getClientProvider;
      const invitation = yield* Organizations.inviteMember(payload).pipe(
        client.provide,
        Effect.mapError((error) => toCliApiError("Could not invite the member", error)),
      );
      if (json) return yield* printJson(invitation);
      yield* printFields([
        ["Invitation", invitation.id],
        ["Email", invitation.email],
        ["Role", invitation.role],
        ["Namespace", invitation.namespaceId ?? "Whole organization"],
      ]);
    }).pipe(json ? Effect.provideService(References.MinimumLogLevel, "None") : identity),
  ),
);
