export const WHATSAPP_MESSAGING_LIMIT_HOLD = "whatsapp_messaging_limit";

interface HeldRun {
  readonly holdReason?: string | null | undefined;
  readonly holdUntil?: string | null | undefined;
}

interface CampaignRunPacing extends HeldRun {
  readonly pendingCount?: number | undefined;
  readonly estimatedCompletionAt?: string | null | undefined;
  readonly capacityWarning?: string | null | undefined;
}

/** The reason a run is held, in words; an unrecognised reason is printed as the API sent it. */
export const holdLabel = (reason: string | null | undefined): string | null =>
  reason === null || reason === undefined
    ? null
    : reason === WHATSAPP_MESSAGING_LIMIT_HOLD
      ? `${reason} (the messaging limit its business portfolio shares across numbers; the run resumes on its own, sooner if Meta raises the limit)`
      : reason;

/** Detail rows for a held run: why, the latest it resumes, and, for a campaign run, how many wait. */
export const holdFields = (run: HeldRun): ReadonlyArray<readonly [string, unknown]> => [
  ["Held", holdLabel(run.holdReason)],
  ["Resumes by", run.holdUntil],
];

/** Pacing rows for a campaign run: the waiting count, the forecast, and the capacity warning. */
export const campaignPacingFields = (
  run: CampaignRunPacing,
  options: { readonly warning: boolean },
): ReadonlyArray<readonly [string, unknown]> => [
  ...holdFields(run),
  [
    "Pending",
    run.pendingCount !== undefined && (run.pendingCount > 0 || run.holdReason != null)
      ? String(run.pendingCount)
      : null,
  ],
  ["Est. completion", run.estimatedCompletionAt],
  ...(options.warning ? ([["Capacity warning", run.capacityWarning]] as const) : []),
];
