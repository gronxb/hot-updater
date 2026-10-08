/**
 * The brand of Hot Updater's own plugins, a registered symbol that
 * `@hot-updater/server` reads to reserve the id "remoteConfig" for this plugin.
 * Each official plugin package keeps this copy, so none imports another's
 * internals for it.
 */
const OFFICIAL = Symbol.for("@hot-updater/server/official-plugin");

/** Marks a plugin one of Hot Updater's own factories made. */
export const markOfficial = <T extends object>(plugin: T): T =>
  Object.defineProperty(plugin, OFFICIAL, { value: true });
