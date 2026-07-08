import path from "node:path";

import type { Plugin } from "vite";

export interface HotUpdaterConsolePluginOptions {
  readonly config?: string;
}

const defaultConfigFile = "hot-updater.config.ts";
const virtualConfigModuleId = "virtual:hot-updater-console/config";
const virtualServerApiModuleId = "virtual:hot-updater-console/server-api";
const resolvedVirtualConfigModuleId = `\0${virtualConfigModuleId}`;
const resolvedVirtualServerApiModuleId = `\0${virtualServerApiModuleId}`;

const toImportPath = (filePath: string) => filePath.split(path.sep).join("/");

const resolveConfigFile = (root: string, config?: string) =>
  path.isAbsolute(config ?? "")
    ? (config ?? defaultConfigFile)
    : path.resolve(root, config ?? defaultConfigFile);

export const hotUpdaterConsole = (
  options: HotUpdaterConsolePluginOptions = {},
): Plugin => {
  let root = process.cwd();
  let configFile = resolveConfigFile(root, options.config);

  return {
    name: "hot-updater-console",
    enforce: "pre",
    configResolved(config) {
      root = config.root;
      configFile = resolveConfigFile(root, options.config);
    },
    resolveId(id) {
      if (id === virtualConfigModuleId) {
        return resolvedVirtualConfigModuleId;
      }

      if (id === virtualServerApiModuleId) {
        return resolvedVirtualServerApiModuleId;
      }

      return undefined;
    },
    load(id) {
      if (
        id !== resolvedVirtualConfigModuleId &&
        id !== resolvedVirtualServerApiModuleId
      ) {
        return undefined;
      }

      this.addWatchFile(configFile);
      const configImportPath = toImportPath(configFile);

      if (id === resolvedVirtualConfigModuleId) {
        return `export { default } from ${JSON.stringify(configImportPath)};`;
      }

      return [
        "export const createConsoleApi = async () => {",
        "  const [{ default: config }, { createHotUpdaterConsoleApi }] = await Promise.all([",
        `    import(${JSON.stringify(configImportPath)}),`,
        '    import("@hot-updater/console/hosted"),',
        "  ]);",
        "  return createHotUpdaterConsoleApi(config);",
        "};",
      ].join("\n");
    },
  };
};
