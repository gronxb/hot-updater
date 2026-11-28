import { Badge } from "@/components/ui/badge";
import { isBuiltinBundleId } from "@/lib/builtin-bundle-id";

/**
 * Whether a reported bundle is one a native build shipped: the report's
 * `minBundleId`, or, from an SDK that reports none, an ID in the built-in
 * shape.
 */
export const isBuiltinBundle = (
  bundleId: string | null | undefined,
  minBundleId: string | undefined,
): boolean =>
  bundleId !== null &&
  bundleId !== undefined &&
  (bundleId === minBundleId || isBuiltinBundleId(bundleId));

/** Marks a bundle ID as the bundle its native build shipped. */
export function BuiltinBundleBadge() {
  return (
    <Badge
      className="shrink-0 font-sans font-normal"
      title="The bundle the native build shipped"
      variant="secondary"
    >
      Built-in bundle
    </Badge>
  );
}
