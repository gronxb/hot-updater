import { cn } from "@/lib/utils";

/**
 * How much of a labeled release's ID shows after its label: a UUIDv7's last
 * group. The head is a timestamp that neighbouring releases share; the tail
 * tells them apart.
 */
const LABELED_ID_TAIL = 12;

interface BundleIdDisplayProps {
  bundleId: string;
  /**
   * The release's label, shown `v12 · <ID tail>`: the name people use for
   * it, then the end of its ID, with the full ID on hover and in what is read
   * aloud or copied. Left out, or null for a release without one, shows the
   * full ID alone.
   */
  label?: number | null;
  maxLength?: number;
  className?: string;
  fullOnMobile?: boolean;
}
export function BundleIdDisplay({
  bundleId,
  label,
  className,
}: BundleIdDisplayProps) {
  if (typeof label !== "number") {
    return (
      <span
        translate="no"
        className={cn("break-all font-mono text-xs tabular-nums", className)}
      >
        {bundleId}
      </span>
    );
  }
  const tail =
    bundleId.length > LABELED_ID_TAIL ? bundleId.slice(-LABELED_ID_TAIL) : null;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-baseline gap-1.5 whitespace-nowrap",
        className,
      )}
      title={bundleId}
    >
      <span
        translate="no"
        className="shrink-0 font-medium text-sm text-foreground tabular-nums"
      >
        v{label}
      </span>
      {/* Read and copied as "v12 <id>"; the flex gap draws the space. */}{" "}
      {tail === null ? null : (
        // The full ID, for screen readers and copy; the tail stands in for it.
        <span className="sr-only" translate="no">
          {bundleId}
        </span>
      )}
      <span aria-hidden="true" className="select-none text-muted-foreground">
        ·
      </span>
      <span
        aria-hidden={tail === null ? undefined : true}
        translate="no"
        className={cn(
          "font-mono text-xs text-muted-foreground tabular-nums",
          tail === null ? null : "select-none",
        )}
      >
        {tail ?? bundleId}
      </span>
    </span>
  );
}
