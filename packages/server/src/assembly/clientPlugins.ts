import { checkReservedId } from "../plugins/official";
import { HotUpdaterConfigError } from "./configError";

/** A client plugin an app adds to `HotUpdater.init`'s `plugins`. */
export interface ClientPluginSpec {
  /** The module that exports it. */
  readonly module: string;
  /** The export, which the app calls with no arguments. */
  readonly name: string;
}

const EXPORT_NAME = /^[A-Za-z_$][\w$]*$/u;

/**
 * Names app code cannot import as they are: reserved words, and the names
 * the printed app code declares itself.
 */
const UNAVAILABLE_NAMES = new Set([
  "App",
  "HotUpdater",
  "arguments",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The client plugins an app adds for the plugins, each once, in plugin
 * order: what init prints in `HotUpdater.init`'s `plugins`. A malformed one,
 * or one name from two modules, throws `HotUpdaterConfigError`.
 */
export const clientPluginsOf = (
  plugins: readonly unknown[],
): readonly ClientPluginSpec[] => {
  if (!Array.isArray(plugins)) {
    throw new HotUpdaterConfigError("plugins must be an array of plugins.");
  }
  const found: ClientPluginSpec[] = [];
  plugins.forEach((plugin, position) =>
    checkReservedId(plugin, `plugins[${position}]`),
  );
  for (const plugin of plugins) {
    if (!isRecord(plugin) || !isRecord(plugin.cli)) continue;
    const value = plugin.cli.clientPlugin;
    if (value === undefined) continue;
    const id = String(plugin.id);
    if (
      !isRecord(value) ||
      typeof value.module !== "string" ||
      value.module === "" ||
      typeof value.name !== "string" ||
      !EXPORT_NAME.test(value.name) ||
      UNAVAILABLE_NAMES.has(value.name)
    ) {
      throw new HotUpdaterConfigError(
        `Plugin "${id}" cli.clientPlugin needs a module and an export name the app can import: an identifier other than a reserved word, App, or HotUpdater.`,
      );
    }
    const { module, name } = value as unknown as ClientPluginSpec;
    const named = found.find((entry) => entry.name === name);
    if (named === undefined) {
      found.push({ module, name });
    } else if (named.module !== module) {
      throw new HotUpdaterConfigError(
        `Plugin "${id}" names the client plugin "${name}" from ${module}, but another plugin names it from ${named.module}.`,
      );
    }
  }
  return found;
};
