"use server";

import {
  loadConfig as HotUpdaterLoadConfig,
  getCwd,
} from "@hot-updater/plugin-core";
import { createServerFn } from "@tanstack/start";

const cwd = getCwd();
const config = await HotUpdaterLoadConfig();

export const isLoadedConfig = createServerFn("GET", async () => {
  return config !== null;
});

export const getUpdateSources = createServerFn("GET", async () => {
  const deployPlugin = config?.deploy({
    cwd,
  });

  return deployPlugin?.getUpdateSources() ?? [];
});
