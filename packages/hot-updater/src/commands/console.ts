import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { type ConfigResponse, loadConfig } from "@hot-updater/cli-tools";
import type { Bundle } from "@hot-updater/core";
import { createHandler } from "@hot-updater/server";
import fs from "fs";
import { Hono } from "hono";
import type { AddressInfo } from "net";
import path from "path";

// Get the console assets directory from @hot-updater/console package
const getConsoleAssetsDir = (): string => {
  try {
    // Try to resolve the @hot-updater/console package
    const consolePkgPath = require.resolve("@hot-updater/console/package.json");
    const consoleDir = path.dirname(consolePkgPath);
    return path.join(consoleDir, "dist");
  } catch {
    // Fallback: look in node_modules
    return path.join(
      process.cwd(),
      "node_modules",
      "@hot-updater",
      "console",
      "dist",
    );
  }
};

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

  // Create console handler with the database plugin API
  const consoleAssetsDir = getConsoleAssetsDir();

  // Check if console assets exist
  const indexHtmlPath = path.join(consoleAssetsDir, "index.html");
  if (!fs.existsSync(indexHtmlPath)) {
    throw new Error(
      `Console assets not found at ${consoleAssetsDir}. ` +
        "Make sure @hot-updater/console is properly installed and built.",
    );
  }

  // Calculate relative path for serve-static
  const relativeAssetsPath = path.relative(process.cwd(), consoleAssetsDir);

  // Create API handler
  const apiHandler = createHandler(
    {
      getAppUpdateInfo: async () => null, // Not used in console
      getBundles: async (options) => {
        return databasePlugin.getBundles(options);
      },
      getBundleById: async (id) => {
        return databasePlugin.getBundleById(id);
      },
      getChannels: async () => {
        return databasePlugin.getChannels();
      },
      insertBundle: async (bundle) => {
        await databasePlugin.appendBundle(bundle);
        await databasePlugin.commitBundle();
      },
      updateBundleById: async (bundleId, data) => {
        await databasePlugin.updateBundle(bundleId, data);
        await databasePlugin.commitBundle();
      },
      deleteBundleById: async (bundleId) => {
        const bundle = await databasePlugin.getBundleById(bundleId);
        if (bundle) {
          await databasePlugin.deleteBundle(bundle as Bundle);
          await databasePlugin.commitBundle();
        }
      },
      deleteStorageFile: storagePlugin
        ? async (storageUri) => {
            await storagePlugin.delete(storageUri);
          }
        : undefined,
    },
    {
      basePath: "",
      consoleConfig: {
        port: config.console.port,
      },
    },
  );

  // Read and cache index.html with basePath injection
  const indexHtml = fs.readFileSync(indexHtmlPath, "utf-8");
  // CLI console serves at root, so basePath is empty
  const basePath = "";
  const scriptTag = `<script>window.__HOT_UPDATER_BASE_PATH__ = "${basePath}";</script>`;
  const modifiedIndexHtml = indexHtml.replace("</head>", `${scriptTag}</head>`);

  // Create Hono app
  const app = new Hono()
    .get("/ping", (c) => c.text("pong"))
    .all("/bundles/*", async (c) => {
      return apiHandler(c.req.raw);
    })
    .all("/bundles", async (c) => {
      return apiHandler(c.req.raw);
    })
    .get("/channels", async (c) => {
      return apiHandler(c.req.raw);
    })
    .get("/config", async (c) => {
      return apiHandler(c.req.raw);
    })
    .use(
      "/assets/*",
      serveStatic({
        root: relativeAssetsPath,
      }),
    )
    .get("*", (c) => {
      // Serve index.html with basePath injection for SPA fallback
      return c.html(modifiedIndexHtml);
    });

  serve(
    {
      fetch: app.fetch,
      port,
    },
    listeningListener,
  );
};
