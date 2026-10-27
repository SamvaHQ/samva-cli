import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";

import { SamvaCliError } from "../errors";

/**
 * Which publication a template send renders.
 *
 * The API accepts an exact `publicationId` or an `inputContractId` that follows
 * the newest publication validating input identically. Both are optional and
 * mutually exclusive, and either one needs the template named by id, because a
 * reference is a statement about one template's history.
 *
 * Every send surface takes the same pair, so they take it from here.
 */

export const publicationIdFlag = Flag.String("publication-id").pipe(
  Flag.withDescription(
    "Pin one exact publication, so nothing published later changes what this renders",
  ),
  Flag.optional,
);

export const inputContractIdFlag = Flag.String("input-contract-id").pipe(
  Flag.withDescription(
    "Follow the newest publication that still validates input identically to this contract",
  ),
  Flag.optional,
);

export interface TemplateReferenceInput {
  readonly templateId: string | undefined;
  readonly publicationId: string | undefined;
  readonly inputContractId: string | undefined;
}

export interface TemplateReferenceFields {
  readonly publicationId?: string;
  readonly inputContractId?: string;
}

export const resolveTemplateReference = (
  input: TemplateReferenceInput,
): Effect.Effect<TemplateReferenceFields, SamvaCliError> => {
  if (input.publicationId && input.inputContractId)
    return Effect.fail(
      new SamvaCliError({
        message:
          "Use either --publication-id or --input-contract-id, not both. One pins an exact publication; the other follows a contract.",
      }),
    );
  if ((input.publicationId ?? input.inputContractId) && !input.templateId)
    return Effect.fail(
      new SamvaCliError({
        message:
          "--publication-id and --input-contract-id reference one template's history, so they need --template-id.",
      }),
    );
  return Effect.succeed({
    ...(input.publicationId === undefined ? {} : { publicationId: input.publicationId }),
    ...(input.inputContractId === undefined ? {} : { inputContractId: input.inputContractId }),
  });
};
