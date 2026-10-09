import { Badge } from "@/components/ui/badge";

/**
 * A built-in bundle's ID: every native build makes it from its build time with
 * the random bits zeroed (the CLI's `generateMinBundleId`, and the iOS and
 * Android fallbacks), or the nil UUID when iOS can't read its build time. A
 * deployed bundle's ID is a random UUIDv7, so it never has this shape.
 */
const BUILTIN_BUNDLE_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-7000-8000-000000000000|00000000-0000-0000-0000-000000000000)$/iu;

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
  (bundleId === minBundleId || BUILTIN_BUNDLE_ID.test(bundleId));

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
