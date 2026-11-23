import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Templates from "samva/effect/templates";

import { deriveOverride } from "../../lib/derive/curated";
import { jsonFlag } from "../../lib/output";

export const briefArgument = Argument.String("brief").pipe(
  Argument.withDescription("What the email or WhatsApp message is for, in a sentence or two"),
);

type Recreation =
  | { readonly status: "exact"; readonly company: string; readonly galleryTemplateId: string }
  | {
      readonly status: "kind-differs";
      readonly company: string;
      readonly galleryTemplateId: string;
      readonly recreationName: string;
    }
  | { readonly status: "missing"; readonly company: string }
  | null;

/** The one-line note a recreation match adds to a suggestion or a created template. */
export const recreationNote = (
  recreation: Recreation,
  startedFrom?: { readonly name: string },
): string | null => {
  if (recreation === null) return null;
  switch (recreation.status) {
    case "exact":
      return `Recreation: starts from Samva's recreation of ${recreation.company}'s email (${recreation.galleryTemplateId}).`;
    case "kind-differs":
      return `Recreation: Samva has no recreation of this kind of email from ${recreation.company}, so it starts from their other recreation, ${recreation.recreationName}, for its look.`;
    case "missing":
      return startedFrom === undefined
        ? `Recreation: the gallery has no recreation of ${recreation.company}'s email.`
        : `Recreation: the gallery has no recreation of ${recreation.company}'s email, so it starts from the closest design, ${startedFrom.name}.`;
  }
};

export const channelFlag = Flag.Literals("channel", ["email", "whatsapp"]).pipe(
  Flag.withDescription("Template channel"),
  Flag.withDefault("email"),
);

export const suggestCommand = deriveOverride(
  "suggest",
  {
    brief: briefArgument,
    channel: channelFlag,
    json: jsonFlag,
  },
  {
    mapInput: ({ brief, channel }) => ({ brief, channel }),
    call: (request) => Templates.suggestStarters(request),
    failure: "Could not suggest templates",
    render: (result) =>
      Effect.gen(function* () {
        if (result.suggestions.length === 0) return yield* Console.log("No suggestions.");
        for (const [index, suggestion] of result.suggestions.entries())
          yield* Console.log(
            `${index + 1}. ${suggestion.name} (${suggestion.galleryTemplateId})\n   ${suggestion.reason}`,
          );
        const note = recreationNote(result.recreation);
        if (note !== null) yield* Console.log(`\n${note}`);
      }),
  },
).pipe(
  Command.withDescription("Suggest the gallery designs that fit a brief, best first"),
  Command.withExamples([
    {
      command: 'samva templates suggest "Welcome email for a coffee subscription"',
      description: "Print the three closest gallery designs and why each fits",
    },
    {
      command: 'samva templates suggest "A Linear-style changelog email" --json',
      description: "Machine-readable suggestions and recreation match",
    },
  ]),
);
