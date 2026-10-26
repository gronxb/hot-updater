import { Badge } from "@/components/ui/badge";

/**
 * A built-in bundle's ID: every native build makes it from its build time with
 * `rand_a` zeroed, and a node that is zero or, from `hot-updater native-build`, a
 * platform byte (`01` iOS, `02` Android) and random bits; or the nil UUID in a
 * debug build. A deployed bundle's ID is a random UUIDv7, so it practically
 * never has this shape.
 */
const BUILTIN_BUNDLE_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-7000-8000-(?:000000000000|0[12][0-9a-f]{10})|00000000-0000-0000-0000-000000000000)$/iu;

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
