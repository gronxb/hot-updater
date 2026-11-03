import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";

dayjs.extend(relativeTime);

/**
 * When something was created, as the Bundles and Native builds lists show
 * it: relative, such as "4 hours ago", with the exact time on hover. A card
 * has no hover, so `withDate` puts the exact time under it.
 */
export function RelativeTime({
  ms,
  withDate = false,
}: {
  /** Epoch milliseconds. */
  readonly ms: number;
  readonly withDate?: boolean;
}) {
  const date = dayjs(ms);
  const exact = date.format("YYYY-MM-DD HH:mm:ss");
  return (
    <time
      className="flex flex-col whitespace-nowrap tabular-nums"
      dateTime={date.toISOString()}
      title={exact}
    >
      <span>{date.fromNow()}</span>
      {withDate ? <span className="text-muted-foreground">{exact}</span> : null}
    </time>
  );
}
