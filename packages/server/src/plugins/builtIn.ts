/** Marks built-in plugins, whose tables keep their names instead of taking the plugin id as a namespace. */
export const builtInPlugin = Symbol.for("@hot-updater/server/built-in-plugin");

export const markBuiltIn = <TPlugin extends object>(plugin: TPlugin): TPlugin =>
  Object.defineProperty(plugin, builtInPlugin, { value: true });
