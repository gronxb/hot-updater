import { Badge } from "@/components/ui/badge";

/** Whether a reported bundle is the one the report's native build shipped. */
export const isBuiltinBundle = (
  bundleId: string | null | undefined,
  minBundleId: string | undefined,
): boolean =>
  bundleId !== null && bundleId !== undefined && bundleId === minBundleId;

/** Marks a bundle ID as the bundle its native build shipped. */
export function BuiltinBundleBadge() {
  return (
    <Badge
      className="shrink-0 font-sans font-normal"
      title="The bundle the native build shipped"
      variant="secondary"
    >
      Built-in app
    </Badge>
  );
}
