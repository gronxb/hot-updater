import { HotUpdaterConfigError } from "../assembly/configError";

/**
 * The brand Hot Updater's own plugin factories set. It is a registered
 * symbol, not a module-private one, so a plugin made by one package's ESM
 * build still carries it when another's CommonJS build reads it, as a config
 * loaded through `require` may; no plugin sets it by accident. Each official
 * plugin package sets it with a copy of its own, so no package imports
 * another's internals for it. It guards Hot Updater's ids against a
 * clash, not against a determined impostor.
 */
const OFFICIAL = Symbol.for("@hot-updater/server/official-plugin");

/**
 * The ids of Hot Updater's own plugins. The console and tooling tell
 * features apart by plugin id, so no other plugin may take one.
 */
const OFFICIAL_IDS: ReadonlySet<string> = new Set([
  "insights",
  "apiKeys",
  "remoteConfig",
]);

/** Whether one of Hot Updater's own factories made `plugin`. */
export const isOfficialPlugin = (plugin: unknown): boolean =>
  typeof plugin === "object" &&
  plugin !== null &&
  Reflect.get(plugin, OFFICIAL) === true;

/**
 * Refuses a plugin that takes one of Hot Updater's own ids without being
 * that plugin: `at` names it in the error, such as `plugins[0]`.
 */
export const checkReservedId = (plugin: unknown, at: string) => {
  const id =
    typeof plugin === "object" && plugin !== null
      ? Reflect.get(plugin, "id")
      : undefined;
  if (
    typeof id === "string" &&
    OFFICIAL_IDS.has(id) &&
    !isOfficialPlugin(plugin)
  ) {
    throw new HotUpdaterConfigError(
      `${at} takes the id "${id}", which is reserved for Hot Updater's ${id}() plugin; give this plugin another id.`,
    );
  }
};
