import * as Flag from "effect/cli/Flag";

/** The templates directory; unset means `templates/` and `emails/`, whichever exist. */
export const dirFlag = Flag.Directory("dir").pipe(
  Flag.withDescription(
    "Directory containing your .tsx templates (default: templates/ and emails/, whichever exist)",
  ),
  Flag.optional,
);

export const assetBaseFlag = Flag.String("asset-base").pipe(
  Flag.withDescription("Actual HTTPS serving base for imported email assets"),
  Flag.optional,
);

export const offlineFlag = Flag.Boolean("offline").pipe(
  Flag.withDescription("Use the cached brand in .samva/brands instead of fetching it"),
  Flag.withDefault(false),
);
