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
   * it, then the end of its ID. The full ID shows on hover, and is what
   * screen readers read and a selection copies. Left out, or null for a
   * release without one, shows the full ID alone.
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
      {/* The whole ID stays in the text, clipped to its tail from the left
          (one `ch` per monospace character), so selecting it copies all of it. */}
      <span
        translate="no"
        className={cn(
          "order-2 font-mono text-xs text-muted-foreground tabular-nums",
          bundleId.length > LABELED_ID_TAIL &&
            "inline-flex w-[12ch] shrink-0 justify-end overflow-hidden",
        )}
      >
        {bundleId}
      </span>
      {/* Drawn between the label and the ID, but after the ID in the text. */}
      <span
        aria-hidden="true"
        className="order-1 select-none text-muted-foreground"
      >
        ·
      </span>
    </span>
  );
}
