import fs from "fs/promises";
import { createRequire, Module } from "module";

import * as analytics from "@hot-updater/analytics";
import * as analyticsProvider from "@hot-updater/analytics/provider";
import * as pluginCore from "@hot-updater/plugin-core";
import type { ConfigInput, Platform } from "@hot-updater/plugin-core";
import * as pluginCoreCapabilities from "@hot-updater/plugin-core/internal/capabilities";
import { createJiti, type JitiOptions } from "jiti";

export type HotUpdaterConfigOptions = {
  platform: Platform;
  channel: string;
} | null;

type ConfigJitiOptions = JitiOptions & {
  virtualModules: Record<string, unknown>;
};

type ConfigExport =
  | ConfigInput
  | ((options: HotUpdaterConfigOptions) => ConfigInput | Promise<ConfigInput>);

const nativeRequire = createRequire(import.meta.url);
let configParseQueue = Promise.resolve();

// Keep every module-scoped capability token on the loader's ESM cohort.
const canonicalConfigModules = Object.freeze([
  Object.freeze({
    exports: analytics,
    specifier: "@hot-updater/analytics",
  }),
  Object.freeze({
    exports: analyticsProvider,
    specifier: "@hot-updater/analytics/provider",
  }),
  Object.freeze({
    exports: pluginCore,
    specifier: "@hot-updater/plugin-core",
  }),
  Object.freeze({
    exports: pluginCoreCapabilities,
    specifier: "@hot-updater/plugin-core/internal/capabilities",
  }),
]);

export const parseConfig = (
  filepath: string,
  options: HotUpdaterConfigOptions,
): Promise<ConfigInput> => {
  const config = configParseQueue.then(async () => {
    const moduleCacheSnapshots = canonicalConfigModules.map(
      (moduleDefinition) => {
        const moduleId = nativeRequire.resolve(moduleDefinition.specifier);
        const cachedModule = nativeRequire.cache[moduleId];

        if (cachedModule) {
          const originalExports = cachedModule.exports;
          cachedModule.exports = moduleDefinition.exports;
          return Object.freeze({
            cachedModule,
            moduleId,
            originalExports,
            wasCached: true,
          });
        }

        const injectedModule = new Module(moduleId);
        injectedModule.filename = moduleId;
        injectedModule.loaded = true;
        injectedModule.exports = moduleDefinition.exports;
        nativeRequire.cache[moduleId] = injectedModule;

        return Object.freeze({
          moduleId,
          wasCached: false,
        });
      },
    );

    try {
      const jiti = createJiti(import.meta.url, {
        fsCache: false,
        interopDefault: true,
        moduleCache: false,
        virtualModules: Object.fromEntries(
          canonicalConfigModules.map((moduleDefinition) => [
            moduleDefinition.specifier,
            moduleDefinition.exports,
          ]),
        ),
      } satisfies ConfigJitiOptions);

      const configModule = (await jiti.evalModule(
        await fs.readFile(filepath, "utf8"),
        {
          async: true,
          filename: filepath,
          forceTranspile: true,
        },
      )) as { default: ConfigExport } | ConfigExport;
      const configExport =
        typeof configModule === "object" &&
        configModule !== null &&
        "default" in configModule
          ? configModule.default
          : configModule;

      return typeof configExport === "function"
        ? configExport(options)
        : configExport;
    } finally {
      for (const snapshot of moduleCacheSnapshots.reverse()) {
        if (snapshot.wasCached) {
          snapshot.cachedModule.exports = snapshot.originalExports;
        } else {
          delete nativeRequire.cache[snapshot.moduleId];
        }
      }
    }
  });

  configParseQueue = config.then(
    () => undefined,
    () => undefined,
  );
  return config;
};
