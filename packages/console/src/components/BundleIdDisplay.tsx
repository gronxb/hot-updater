import { cn } from "@/lib/utils";

interface BundleIdDisplayProps {
  bundleId: string;
  /**
   * The release's label, shown `v12` before its ID: the name people use for
   * it. Left out, or null for a release without one, shows the ID alone.
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
  const id = (
    <span
      translate="no"
      className={cn(
        "break-all font-mono text-xs tabular-nums",
        typeof label === "number" ? "text-muted-foreground" : null,
        typeof label === "number" ? null : className,
      )}
    >
      {bundleId}
    </span>
  );
  if (typeof label !== "number") return id;
  return (
    <span
      className={cn("inline-flex min-w-0 items-baseline gap-1.5", className)}
    >
      <span
        translate="no"
        className="shrink-0 font-medium text-sm text-foreground tabular-nums"
      >
        v{label}
      </span>
      {/* Read and copied as "v12 <id>"; the flex gap draws the space. */} {id}
    </span>
  );
}
