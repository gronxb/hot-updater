import { serve } from "@hono/node-server";
import { type ConfigResponse, loadConfig } from "@hot-updater/cli-tools";
import { createHotUpdater } from "@hot-updater/server";
import { Hono } from "hono";
import type { AddressInfo } from "net";

export const getConsolePort = async (config?: ConfigResponse) => {
  if (config?.console.port) {
    return config.console.port;
  }

  const $config = await loadConfig(null);
  return $config.console.port;
};

export const openConsole = async (
  port: number,
  listeningListener?: ((info: AddressInfo) => void) | undefined,
) => {
  const config = await loadConfig(null);

  const databasePlugin = (await config?.database()) ?? null;
  const storagePlugin = (await config?.storage()) ?? null;

  if (!databasePlugin) {
    throw new Error(
      "Database plugin initialization failed. Check your hot-updater.config.ts",
    );
  }

  // Create HotUpdater API with database and storage plugins
  // API routes are served at /api (hardcoded)
  const hotUpdater = createHotUpdater({
    database: databasePlugin,
    storages: storagePlugin ? [storagePlugin] : [],
    basePath: "/", // Handler serves at root, no prefix to strip
    // consoleAssetsDir is auto-resolved
    console: {
      gitUrl: config.console.gitUrl,
    },
  });

  // Create Hono app
  const app = new Hono()
    .get("/ping", (c) => c.text("pong"))
    // Console handler handles everything: API routes, static files, and SPA fallback
    .on(["GET", "POST", "PATCH", "DELETE"], "/*", async (c) => {
      return hotUpdater.console.handler(c.req.raw);
    });

  serve(
    {
      fetch: app.fetch,
      port,
    },
    listeningListener,
  );
};
