import type { NativeBuildRow } from "@hot-updater/plugin-core";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { Send } from "lucide-react";

import { Badge } from "@/components/ui/badge";

dayjs.extend(relativeTime);

/** Each store track's name as the stores call it. */
export const storeTrackLabels = {
  testflight: "TestFlight",
  "play-internal": "Play internal",
} as const satisfies Record<
  NonNullable<NativeBuildRow["submitted_to"]>,
  string
>;

export type Submitted = NativeBuildRow & {
  readonly submitted_to: NonNullable<NativeBuildRow["submitted_to"]>;
};

/** Whether a store took the build, as its row records. */
export const isSubmitted = (build: NativeBuildRow): build is Submitted =>
  build.submitted_to !== null && build.submitted_to !== undefined;

/** When the submission was recorded: relative, with the exact time on hover. */
function SubmittedAt({ ms }: { readonly ms: number | null }) {
  if (ms === null) return null;
  const date = dayjs(ms);
  return (
    <time
      className="text-xs text-muted-foreground"
      dateTime={date.toISOString()}
      title={date.format("YYYY-MM-DD HH:mm:ss")}
    >
      {date.fromNow()}
    </time>
  );
}

/**
 * The store track a build went to, with the store's label of it, such as
 * "TestFlight 1.7.0 (66)": none for a build no store took.
 */
export function StoreSubmissionBadge({
  build,
  withTime = false,
}: {
  readonly build: NativeBuildRow;
  /** Whether to show when it was submitted beside the badge. */
  readonly withTime?: boolean;
}) {
  if (!isSubmitted(build)) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge
        className="gap-1"
        title={`Submitted to ${storeTrackLabels[build.submitted_to]}`}
        variant="secondary"
      >
        <Send aria-hidden="true" className="size-3" />
        {storeTrackLabels[build.submitted_to]}
        {build.submitted_version ? (
          <span className="font-mono tabular-nums" translate="no">
            {build.submitted_version}
          </span>
        ) : null}
      </Badge>
      {withTime ? <SubmittedAt ms={build.submitted_at_ms} /> : null}
    </span>
  );
}
