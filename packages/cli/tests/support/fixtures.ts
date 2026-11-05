import type { EmailDomain } from "@samva/contracts/email/group";

/**
 * One `EmailDomain` list row as the API encodes it. Fake servers build domains here so a field
 * the contract adds lands once instead of in every suite's literal.
 */
export const emailDomainFixture = (
  overrides: Partial<typeof EmailDomain.Encoded> = {},
): typeof EmailDomain.Encoded => ({
  id: "dom_1234567890abcdefgh",
  unknownRecipientMailboxId: null,
  namespaceId: null,
  domain: "example.com",
  phase: "ready",
  isDefault: false,
  deliverability: { bounceRate: 0, complaintRate: 0, windowSends: 0, sendingStatus: "unknown" },
  series: Array.from({ length: 14 }, () => 0),
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  ...overrides,
});
