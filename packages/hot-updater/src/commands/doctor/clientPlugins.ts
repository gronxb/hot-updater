import fs from "node:fs/promises";

import type { PluginClientPlugin } from "@hot-updater/plugin-core";
import fg from "fast-glob";

import type { LoadedServer } from "../../utils/loadServer";

/** Files that hold no app code of the project's own. */
const NOT_APP_CODE = [
  "**/node_modules/**",
  "ios/**",
  "android/**",
  "**/dist/**",
  "**/build/**",
  "**/.hot-updater/**",
  "**/*.d.ts",
];

const isClientPlugin = (value: unknown): value is PluginClientPlugin =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { module?: unknown }).module === "string" &&
  typeof (value as { name?: unknown }).name === "string";

/**
 * The client plugins the server's plugins need: from its definition, or
 * from the admin `/version` of a self-hosted server `standaloneRepository`
 * reaches. The caller owns `server` and closes it.
 */
export const readServerClientPlugins = async (
  server: LoadedServer,
): Promise<readonly PluginClientPlugin[]> => {
  if (server.kind === "definition") return server.definition.clientPlugins;
  const response = await server.server.fetchAdmin("/version");
  if (!response.ok) {
    throw new Error(`The server answered /version with ${response.status}.`);
  }
  const listed = ((await response.json()) as { clientPlugins?: unknown })
    .clientPlugins;
  return Array.isArray(listed) ? listed.filter(isClientPlugin) : [];
};

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");

/** Whether `source` imports the client plugin as a value: `name`, or all of `module`. */
export const importsClientPlugin = (
  source: string,
  { module, name }: PluginClientPlugin,
): boolean => {
  const from = `\\s*from\\s*["']${escapeRegExp(module)}["']`;
  if (new RegExp(`import\\s+\\*\\s+as\\s+[\\w$]+${from}`, "u").test(source)) {
    return true;
  }
  for (const match of source.matchAll(
    new RegExp(`import\\s+\\{([^}]*)\\}${from}`, "gu"),
  )) {
    const names = match[1]!
      .split(",")
      .map((entry) => entry.trim().split(/\s+as\s+/u)[0]);
    if (names.includes(name)) return true;
  }
  return false;
};

/**
 * The client plugins among `clientPlugins` that no source file of the app
 * in `cwd` imports, so none is passed to `HotUpdater.init({ plugins })`.
 */
export const findMissingClientPlugins = async ({
  clientPlugins,
  cwd,
}: {
  readonly clientPlugins: readonly PluginClientPlugin[];
  readonly cwd: string;
}): Promise<PluginClientPlugin[]> => {
  if (clientPlugins.length === 0) return [];
  const files = await fg("**/*.{ts,tsx,js,jsx,mjs,cjs}", {
    absolute: true,
    cwd,
    ignore: NOT_APP_CODE,
  });
  const sources = await Promise.all(
    files.map((file) => fs.readFile(file, "utf8")),
  );
  return clientPlugins.filter(
    (plugin) =>
      !sources.some(
        (source) =>
          source.includes(plugin.module) && importsClientPlugin(source, plugin),
      ),
  );
};
