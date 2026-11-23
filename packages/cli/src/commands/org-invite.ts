import { InviteMemberPayload } from "@samva/contracts/organizations/group";
import { EmailAddressString, NamespaceId } from "@samva/core/shared/base";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Option from "effect/Option";
import * as Organizations from "samva/effect/organizations";

import { deriveOverride } from "../lib/derive/curated";
import { jsonFlag, printFields } from "../lib/output";

export const orgInviteCommand = deriveOverride(
  "invite",
  {
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
  },
  {
    mapInput: ({ email, role, mailboxAddress, namespace }) => ({
      email,
      role,
      mailboxAddress,
      namespaceId: Option.getOrUndefined(namespace),
    }),
    call: (request) => Organizations.inviteMember(request),
    failure: "Could not invite the member",
    preview: {
      data: (payload) => ({ dryRun: true, ...payload }),
      render: ({ email, role, mailboxAddress, namespaceId }) =>
        printFields([
          ["Email", email],
          ["Role", role],
          ["Personal mailbox", mailboxAddress],
          ["Namespace", namespaceId ?? "Whole organization"],
        ]),
    },
    render: (invitation) =>
      printFields([
        ["Invitation", invitation.id],
        ["Email", invitation.email],
        ["Role", invitation.role],
        ["Namespace", invitation.namespaceId ?? "Whole organization"],
      ]),
  },
).pipe(
  Command.withDescription("Invite a teammate, optionally restricted to one namespace"),
  Command.withExamples([
    {
      command:
        "samva org invite ada@example.com --mailbox-address ada@acme.example --namespace ns_1234567890123456 --role member",
      description: "Invite a teammate into one namespace",
    },
  ]),
);
