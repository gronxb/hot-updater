import fs from "node:fs/promises";

import type { ConfigResponse } from "@hot-updater/cli-tools";
import { type ClientPluginSpec, clientPluginsOf } from "@hot-updater/server/db";
import fg from "fast-glob";

import { loadServer } from "../../utils/loadServer";

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

const isClientPluginSpec = (value: unknown): value is ClientPluginSpec =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { module?: unknown }).module === "string" &&
  typeof (value as { name?: unknown }).name === "string";

/**
 * The client plugins the server's plugins need: from its definition, or
 * from the admin `/version` of a self-hosted server `standaloneRepository`
 * reaches.
 */
export const readServerClientPlugins = async (
  config: Pick<ConfigResponse, "server">,
): Promise<readonly ClientPluginSpec[]> => {
  const server = await loadServer(config);
  try {
    if (server.kind === "definition") return clientPluginsOf(server.plugins);
    const response = await server.server.fetchAdmin("/version");
    if (!response.ok) {
      throw new Error(`The server answered /version with ${response.status}.`);
    }
    const listed = ((await response.json()) as { clientPlugins?: unknown })
      .clientPlugins;
    return Array.isArray(listed) ? listed.filter(isClientPluginSpec) : [];
  } finally {
    await server.dispose();
  }
};

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");

/** Whether `source` imports the client plugin as a value: `name`, or all of `module`. */
export const importsClientPlugin = (
  source: string,
  { module, name }: ClientPluginSpec,
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
  readonly clientPlugins: readonly ClientPluginSpec[];
  readonly cwd: string;
}): Promise<ClientPluginSpec[]> => {
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
