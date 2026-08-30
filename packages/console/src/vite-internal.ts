import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import type { Plugin, PluginOption, UserConfig } from "vite";

import type { HotUpdaterConsolePluginOptions } from "./vite";

const virtualAuthModuleId = "virtual:hot-updater-console/auth";
const virtualConfigModuleId = "virtual:hot-updater-console/config";
const virtualPackageRouterModuleId =
  "virtual:hot-updater-console/package-router";
const virtualRouteTreeModuleId = "virtual:hot-updater-console/route-tree";

const resolvedVirtualAuthModuleId = `\0${virtualAuthModuleId}`;
const resolvedVirtualConfigModuleId = `\0${virtualConfigModuleId}`;
const resolvedVirtualPackageRouterModuleId = `\0${virtualPackageRouterModuleId}`;

const packageRoot = path.resolve(import.meta.dirname, "..");
const packagePublicDirectory = path.join(packageRoot, "public");
const packageRouterFile = path.join(packageRoot, "src/router.tsx");
const packageRoutesDirectory = path.join(packageRoot, "src/routes");
const packageSourceDirectory = path.join(packageRoot, "src");
const localRouteTreeFile = path.join(
  packageSourceDirectory,
  "routeTree.gen.ts",
);

type ConsoleModuleMode =
  | {
      readonly type: "hosted";
      readonly options: HotUpdaterConsolePluginOptions;
    }
  | { readonly type: "local" };

const resolveFromRoot = (root: string, file: string) =>
  path.isAbsolute(file) ? file : path.resolve(root, file);

const toImportPath = (file: string) => file.split(path.sep).join("/");

const writeFileIfChanged = (file: string, contents: string) => {
  if (existsSync(file) && readFileSync(file, "utf8") === contents) {
    return;
  }

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
};

const createConsoleModulesPlugin = (mode: ConsoleModuleMode): Plugin => {
  let authFile = "";
  let configFile = "";
  let generatedRouteTreeFile = localRouteTreeFile;

  return {
    name: `hot-updater-console:${mode.type}-modules`,
    enforce: "pre",
    config(userConfig, configEnvironment) {
      const root = path.resolve(process.cwd(), userConfig.root ?? ".");

      if (mode.type === "hosted") {
        const cacheDirectory = path.join(root, ".hot-updater/console");
        generatedRouteTreeFile = path.join(cacheDirectory, "routeTree.gen.ts");
        authFile = resolveFromRoot(
          root,
          mode.options.auth ?? "console.auth.ts",
        );
        configFile = resolveFromRoot(
          root,
          mode.options.config ?? "hot-updater.config.ts",
        );

        writeFileIfChanged(
          path.join(cacheDirectory, "router.ts"),
          [
            `export { getRouter } from ${JSON.stringify(virtualPackageRouterModuleId)};`,
            "",
          ].join("\n"),
        );
      }

      return {
        assetsInclude: ["**/*.node"],
        oxc: {
          jsx: {
            development: configEnvironment.command === "serve",
          },
        },
        resolve: {
          alias: [
            {
              find: /^@\//,
              replacement: `${toImportPath(packageSourceDirectory)}/`,
            },
          ],
          dedupe: [
            "react",
            "react-dom",
            "@tanstack/react-query",
            "@tanstack/react-router",
            "@tanstack/react-start",
          ],
        },
      } satisfies UserConfig;
    },
    resolveId(id) {
      if (id === virtualAuthModuleId) {
        return resolvedVirtualAuthModuleId;
      }
      if (id === virtualConfigModuleId) {
        return resolvedVirtualConfigModuleId;
      }
      if (id === virtualPackageRouterModuleId) {
        return resolvedVirtualPackageRouterModuleId;
      }
      if (id === virtualRouteTreeModuleId) {
        return generatedRouteTreeFile;
      }
      return undefined;
    },
    load(id) {
      if (id === resolvedVirtualPackageRouterModuleId) {
        return `export { getRouter } from ${JSON.stringify(toImportPath(packageRouterFile))};`;
      }

      if (id === resolvedVirtualConfigModuleId) {
        if (mode.type === "local") {
          return [
            'import { loadConfig } from "@hot-updater/cli-tools";',
            "export default async () => {",
            "  const config = await loadConfig(null);",
            "  return {",
            "    console: { gitUrl: config.console.gitUrl },",
            "    database: config.database,",
            "    storage: config.storage,",
            "  };",
            "};",
          ].join("\n");
        }

        this.addWatchFile(configFile);
        return `export { default } from ${JSON.stringify(toImportPath(configFile))};`;
      }

      if (id === resolvedVirtualAuthModuleId) {
        if (mode.type === "local") {
          return [
            'const principal = { email: "local@hot-updater.dev", name: "Local Console" };',
            "export default {",
            "  async handle() {",
            '    return new Response("Not Found", { status: 404 });',
            "  },",
            "  async getAccess() {",
            '    return { status: "authorized", principal };',
            "  },",
            "  async getProviders() {",
            "    return [];",
            "  },",
            "};",
          ].join("\n");
        }

        this.addWatchFile(authFile);
        return `export { default } from ${JSON.stringify(toImportPath(authFile))};`;
      }

      return undefined;
    },
  };
};

export const createHostedConsolePlugins = (
  options: HotUpdaterConsolePluginOptions,
): PluginOption[] => [
  createConsoleModulesPlugin({ type: "hosted", options }),
  nitro({
    publicAssets: [{ dir: packagePublicDirectory, maxAge: 60 * 60 * 24 }],
  }),
  tailwindcss(),
  tanstackStart({
    srcDirectory: ".hot-updater/console",
    router: {
      generatedRouteTree: "routeTree.gen.ts",
      routesDirectory: packageRoutesDirectory,
    },
  }),
  viteReact(),
];

export const createLocalConsoleModulesPlugin = (): Plugin =>
  createConsoleModulesPlugin({ type: "local" });
