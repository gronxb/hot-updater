/**
 * A built-in bundle's ID: every native build makes it from its build time with
 * zero random bits, and builds an earlier `hot-updater native-build` made, in
 * the field still, have a node of a platform byte (`01` iOS, `02` Android) and
 * random bits; or the nil UUID in a debug build. A deployed bundle's ID is a
 * random UUIDv7, so it practically never has this shape.
 */
const BUILTIN_BUNDLE_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-7000-8000-(?:000000000000|0[12][0-9a-f]{10})|00000000-0000-0000-0000-000000000000)$/iu;

/** Whether an ID has the shape of a built-in bundle's. */
export const isBuiltinBundleId = (id: string): boolean =>
  BUILTIN_BUNDLE_ID.test(id);
