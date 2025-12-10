import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { type ConfigResponse, loadConfig } from "@hot-updater/cli-tools";
import { createHotUpdater } from "@hot-updater/server";
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

  // Create HotUpdater API with database and storage plugins
  const hotUpdater = createHotUpdater({
    database: databasePlugin,
    storages: storagePlugin ? [storagePlugin] : [],
    basePath: "", // Handler serves at root, no prefix to strip
    consolePath: "/api", // Frontend fetches from /api/bundles (matches handler routes)
  });

  // Read and cache index.html with config injection
  const indexHtml = fs.readFileSync(indexHtmlPath, "utf-8");
  const basePath = "/api";
  const consoleConfig = {
    gitUrl: config.console.gitUrl,
  };
  const scriptTag = `<script>
  window.__HOT_UPDATER_BASE_PATH__ = "${basePath}";
  window.__HOT_UPDATER_CONFIG__ = ${JSON.stringify(consoleConfig)};
</script>`;
  const modifiedIndexHtml = indexHtml.replace("</head>", `${scriptTag}</head>`);

  // Create Hono app
  const app = new Hono()
    .get("/ping", (c) => c.text("pong"))
    // Call hotUpdater.handler ONCE with array of route patterns
    .on(
      ["GET", "POST", "PATCH", "DELETE"],
      ["/api/*"], // Console only needs API management routes
      async (c) => {
        return hotUpdater.handler(c.req.raw);
      },
    )
    // Static file serving
    .use(
      "/assets/*",
      serveStatic({
        root: relativeAssetsPath,
      }),
    )
    // SPA fallback for console routes
    .get("*", (c) => {
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
