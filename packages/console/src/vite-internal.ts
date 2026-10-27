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
const virtualPackageStartModuleId = "virtual:hot-updater-console/package-start";
const virtualRequestGuardModuleId = "virtual:hot-updater-console/request-guard";

const resolvedVirtualAuthModuleId = `\0${virtualAuthModuleId}`;
const resolvedVirtualConfigModuleId = `\0${virtualConfigModuleId}`;
const resolvedVirtualPackageRouterModuleId = `\0${virtualPackageRouterModuleId}`;
const resolvedVirtualPackageStartModuleId = `\0${virtualPackageStartModuleId}`;
const resolvedVirtualRequestGuardModuleId = `\0${virtualRequestGuardModuleId}`;

const packageRoot = path.resolve(import.meta.dirname, "..");
const packagePublicDirectory = path.join(packageRoot, "public");
const packageRouterFile = path.join(packageRoot, "src/router.tsx");
const packageStartFile = path.join(packageRoot, "src/start.ts");
const localConsoleGuardFile = path.join(
  packageRoot,
  "src/lib/server/local-console.ts",
);
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
          mode.options.config ?? "console.config.ts",
        );

        writeFileIfChanged(
          path.join(cacheDirectory, "router.ts"),
          [
            `export { getRouter } from ${JSON.stringify(virtualPackageRouterModuleId)};`,
            "",
          ].join("\n"),
        );
        // The package's request middleware, same-origin server functions
        // included, which TanStack Start reads from the source directory.
        writeFileIfChanged(
          path.join(cacheDirectory, "start.ts"),
          [
            `export { startInstance } from ${JSON.stringify(virtualPackageStartModuleId)};`,
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
      if (id === virtualPackageStartModuleId) {
        return resolvedVirtualPackageStartModuleId;
      }
      if (id === virtualRequestGuardModuleId) {
        return resolvedVirtualRequestGuardModuleId;
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

      if (id === resolvedVirtualPackageStartModuleId) {
        return `export { startInstance } from ${JSON.stringify(toImportPath(packageStartFile))};`;
      }

      if (id === resolvedVirtualRequestGuardModuleId) {
        if (mode.type === "hosted") {
          // Its sign-in guards a hosted console.
          return "export default undefined;";
        }
        // `hot-updater console` passes the run's session. Vite's dev server
        // checks the Host header itself, and a dev console makes its own
        // session and prints the link.
        return [
          `import { guardLocalConsoleRequest, LOCAL_CONSOLE_SESSION_ENV, LOCAL_CONSOLE_SESSION_PARAM } from ${JSON.stringify(toImportPath(localConsoleGuardFile))};`,
          "let session = process.env[LOCAL_CONSOLE_SESSION_ENV] || undefined;",
          "if (session === undefined && import.meta.env.DEV) {",
          "  const bytes = crypto.getRandomValues(new Uint8Array(32));",
          '  session = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");',
          "  console.info(`Open the console at /?${LOCAL_CONSOLE_SESSION_PARAM}=${session}`);",
          "}",
          "const port = process.env.NITRO_PORT || process.env.PORT || undefined;",
          "export default (request) =>",
          "  guardLocalConsoleRequest(request, {",
          "    session,",
          "    port: import.meta.env.DEV ? undefined : port,",
          "    checkHost: !import.meta.env.DEV,",
          "  });",
        ].join("\n");
      }

      if (id === resolvedVirtualConfigModuleId) {
        if (mode.type === "local") {
          // hot-updater.config.ts's database, storage, and plugins, as the
          // CLI loads them.
          return [
            'import { loadConfig } from "@hot-updater/cli-tools";',
            "export default async () => {",
            "  const config = await loadConfig(null);",
            "  if (config.database === undefined) {",
            "    throw new Error(",
            '      "Set database in hot-updater.config.ts: the database your server runs on, such as d1Database(...), or standaloneRepository({ baseUrl }) to reach a self-hosted server through its admin API.",',
            "    );",
            "  }",
            "  if (config.storage === undefined) {",
            "    throw new Error(",
            '      "Set storage in hot-updater.config.ts: where your server stores bundles, which the console reads, such as r2Storage(...).",',
            "    );",
            "  }",
            "  return {",
            "    database: config.database,",
            "    storage: config.storage,",
            "    plugins: config.plugins,",
            "    console: {",
            "      gitUrl: config.console.gitUrl,",
            "      channelLinkPrefix: config.console.channelLinkPrefix,",
            "      updateStrategy: config.updateStrategy,",
            "    },",
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
