import { HotUpdaterConfigError } from "./configError";

/**
 * The brand Hot Updater's own plugin factories set. It is a registered
 * symbol, not a module-private one, so a plugin made by this package's ESM
 * build still carries it when the CommonJS build assembles it, as a config
 * loaded through `require` may; no plugin sets it by accident.
 */
const OFFICIAL = Symbol.for("@hot-updater/server/official-plugin");

/**
 * The ids of Hot Updater's own plugins. The console and tooling tell
 * features apart by plugin id, so no other plugin may take one.
 */
const OFFICIAL_IDS: ReadonlySet<string> = new Set(["insights", "apiKeys"]);

/** Marks a plugin one of Hot Updater's own factories made. */
export const markOfficial = <T extends object>(plugin: T): T =>
  Object.defineProperty(plugin, OFFICIAL, { value: true });

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
