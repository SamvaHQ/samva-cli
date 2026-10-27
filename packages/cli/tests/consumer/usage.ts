/**
 * A separate consumer project: the modules `samva templates types` wrote, and the SDK type they
 * feed. It compiles under `strict` with `exactOptionalPropertyTypes`, which is what makes the
 * generated input types worth generating, and again under `strict` alone, which is where an
 * optional property stops being a JSON value (`tsconfig.default.json`).
 *
 * `packages/cli`'s `typecheck` script compiles both, so a generator change that produces something
 * a customer could not compile fails there.
 */
import type { SamvaClient } from "samva";
import type * as Email from "samva/effect/email";

import {
  samvaTemplates,
  templateContent,
  type ReceiptInput,
  type SamvaTemplateInputs,
  type TemplateSlug,
  type WeeklyDigestInput,
  type WelcomeInput,
} from "./samva-templates";
import {
  templateContent as contentBySlug,
  type SamvaTemplateInputs as InputsBySlug,
  type TemplateSlug as SlugBySlug,
} from "./samva-templates-by-slug";
import { templateContent as wideContent } from "./samva-templates-wide";
import { templateContent as wideContentBySlug } from "./samva-templates-wide-by-slug";

/** What `email.send` accepts: the content a helper returns is spread into it. */
type SendInput = Parameters<SamvaClient["email"]["send"]>[0];
const accept = (input: SendInput): SendInput => input;
/** The Effect entrypoint takes the same content. */
const acceptEffect = (input: Parameters<typeof Email.send>[0]) => input;

const welcome: WelcomeInput = { firstName: "Ada", plan: "pro", seats: 3 };
const digest: WeeklyDigestInput = {
  items: [{ title: "Shipped", children: [{ title: "The compiler" }] }],
};

/**
 * A schema with declared properties and an open additional type compiles, and
 * still checks the declared ones.
 */
const receipt: ReceiptInput = { orderId: "ord_1", total: 42, note: "gift wrapped" };

/** An exact reference travels with the input, ready for `email.send`. */
export const content = templateContent("welcome", welcome);
export const digestContent = templateContent("weekly-digest", digest);

/** The default reference is the exact publication, not the template alone. */
const pinned: { readonly templateId: string; readonly publicationId: string } =
  samvaTemplates.welcome;
export const pinnedPublication = pinned.publicationId;

// A value the published schema rejects is rejected here, before a send exists.
// @ts-expect-error `seats` is a number in the published schema.
templateContent("welcome", { firstName: "Ada", plan: "pro", seats: "3" });
// @ts-expect-error `plan` accepts only the published enum members.
templateContent("welcome", { firstName: "Ada", plan: "enterprise", seats: 3 });
// @ts-expect-error `firstName` is required.
templateContent("welcome", { plan: "pro", seats: 3 });
// @ts-expect-error the schema declares no additional properties.
templateContent("welcome", { firstName: "Ada", plan: "pro", seats: 3, extra: true });
// @ts-expect-error one template's input is not another's.
templateContent("weekly-digest", welcome);
// @ts-expect-error only published templates are addressable.
templateContent("does-not-exist", {});

export const receiptContent = templateContent("receipt", receipt);
// @ts-expect-error `total` is a number in the published schema.
templateContent("receipt", { orderId: "ord_1", total: "42" });
// @ts-expect-error an extra property still has to be one of the schema's types.
templateContent("receipt", { orderId: "ord_1", total: 42, note: true });
// An extra key typed like a declared property is accepted although the schema
// admits only strings: the open value type has to include the declared types
// or no object would satisfy the intersection. The declared properties stay
// exactly checked, and the API validates the rest.
export const looseExtra = templateContent("receipt", { orderId: "o", total: 1, note: 7 });

/** Every key the catalog carries is addressable by name. */
export const names: readonly (keyof SamvaTemplateInputs)[] = [
  "welcome",
  "weekly-digest",
  "receipt",
];

// A generated input is always assignable to what `email.send` accepts, optional properties
// included, with no field stripped by hand.
const withOptional: WelcomeInput = { firstName: "Ada", plan: "pro", seats: 3, invitedBy: "Grace" };
export const sendById = accept({
  to: "ada@example.com",
  ...templateContent("welcome", withOptional),
});
export const sendByIdWithout = accept({ to: "ada@example.com", ...content });
export const sendReceipt = accept({ to: "ada@example.com", ...receiptContent });
export const sendDigest = accept({ to: "ada@example.com", ...digestContent });

// By slug, the content is `{ templateSlug, templateData }` and nothing else.
export const sendBySlug = accept({
  to: "ada@example.com",
  ...contentBySlug("welcome", withOptional),
});
const slugged: { readonly templateSlug: "welcome" } = contentBySlug("welcome", welcome);
export const sentSlug: "welcome" = slugged.templateSlug;
// @ts-expect-error a slug send carries no template id.
void contentBySlug("welcome", welcome).templateId;
// @ts-expect-error `seats` is a number in the template's input contract.
contentBySlug("welcome", { firstName: "Ada", plan: "pro", seats: "3" });
// @ts-expect-error one template's input is not another's.
contentBySlug("weekly-digest", welcome);
// @ts-expect-error only templates in the file are addressable.
contentBySlug("does-not-exist", {});

/** A generic mailer: the helper works for a slug the caller has not narrowed. */
export const sendTemplate = <Slug extends TemplateSlug>(
  slug: Slug,
  data: SamvaTemplateInputs[Slug],
) => accept({ to: "ada@example.com", ...templateContent(slug, data) });
export const sendTemplateBySlug = <Slug extends SlugBySlug>(slug: Slug, data: InputsBySlug[Slug]) =>
  accept({ to: "ada@example.com", ...contentBySlug(slug, data) });
sendTemplate("welcome", welcome);
sendTemplateBySlug("welcome", welcome);
// @ts-expect-error the generic helper still ties the data to the slug.
sendTemplateBySlug("welcome", digest);

/** Nested objects, long unions and arrays of unions send as well. */
export const sendWide = accept({
  to: "ada@example.com",
  ...wideContent("subscription-renewal-reminder-for-annual-plans", {
    plan: "annual-plan-tier-3",
    contact: { name: "Ada", billing: { country: "GB" } },
    lines: ["Setup", { label: "Seats", amount: 3 }],
  }),
});
export const sendWideBySlug = accept({
  to: "ada@example.com",
  ...wideContentBySlug("subscription-renewal-reminder-for-annual-plans", {
    plan: "annual-plan-tier-3",
    contact: { name: "Ada" },
    lines: [],
  }),
});

export const effectById = acceptEffect({
  to: "ada@example.com",
  ...templateContent("weekly-digest", digest),
});
export const effectBySlug = acceptEffect({
  to: "ada@example.com",
  ...contentBySlug("weekly-digest", digest),
});
