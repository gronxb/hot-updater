import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Auto-resolve the console assets directory from @hot-updater/console package
 */
function resolveConsoleAssetsDir(): string {
  try {
    // Try to resolve the @hot-updater/console package
    const consolePkgPath = require.resolve("@hot-updater/console/package.json");
    const consoleDir = dirname(consolePkgPath);
    return join(consoleDir, "dist");
  } catch {
    // Fallback: look in node_modules
    return join(
      process.cwd(),
      "node_modules",
      "@hot-updater",
      "console",
      "dist",
    );
  }
}

export interface ConsoleHandlerOptions {
  /**
   * Base path for console routes (e.g., "/console")
   * This value will be injected into the frontend HTML as window.__HOT_UPDATER_BASE_PATH__
   */
  basePath?: string;
  /**
   * Path to console assets directory
   * If not provided, automatically resolves from @hot-updater/console package
   */
  consoleAssetsDir?: string;
  /**
   * Configuration to inject into HTML as window.__HOT_UPDATER_CONFIG__
   */
  config?: Record<string, unknown>;
  /**
   * API handler function to handle API routes
   * If provided, requests matching consolePath will be forwarded to this handler
   */
  apiHandler?: (request: Request) => Promise<Response>;
}

export interface ConsoleHandler {
  handler: (request: Request) => Promise<Response>;
}

/**
 * Get MIME type for a file based on its extension
 */
function getMimeType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    html: "text/html",
    css: "text/css",
    js: "application/javascript",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    eot: "application/vnd.ms-fontobject",
  };
  return mimeTypes[ext || ""] || "application/octet-stream";
}

/**
 * Injects basePath and config into HTML by adding a script tag before </head>
 */
function injectConfigIntoHtml(
  html: string,
  basePath: string,
  config?: Record<string, unknown>,
): string {
  const scriptTag = `<script>
  window.__HOT_UPDATER_BASE_PATH__ = "${basePath}";
  window.__HOT_UPDATER_CONFIG__ = ${JSON.stringify(config || {})};
</script>`;

  // Inject before </head>
  return html.replace("</head>", `${scriptTag}</head>`);
}

/**
 * Creates a console handler that handles API routes, static files, and SPA fallback.
 * This handler is fully self-contained and can be used with a single line in your app.
 */
export function createConsoleHandler(
  options: ConsoleHandlerOptions,
): ConsoleHandler {
  const {
    basePath = "",
    consoleAssetsDir: userProvidedAssetsDir,
    config,
    apiHandler,
  } = options;

  // Auto-resolve console assets directory if not provided
  const consoleAssetsDir = userProvidedAssetsDir ?? resolveConsoleAssetsDir();

  // Normalize basePath: "/" is treated as "" (no prefix to strip)
  const normalizedBasePath = basePath === "/" ? "" : basePath;

  // Console API path is always "/api"
  const consolePath = "/api";

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    let path = url.pathname;

    // Strip base path if present
    if (normalizedBasePath && path.startsWith(normalizedBasePath)) {
      path = path.slice(normalizedBasePath.length) || "/";
    }

    // 1. Route API requests to apiHandler
    if (path.startsWith(consolePath) && apiHandler) {
      return apiHandler(request);
    }

    // 2. Serve static files from consoleAssetsDir
    if (consoleAssetsDir) {
      // Serve assets from /assets/*
      if (path.startsWith("/assets/")) {
        const filePath = path.replace("/assets/", "");
        const fullPath = join(consoleAssetsDir, "assets", filePath);

        if (existsSync(fullPath)) {
          const content = readFileSync(fullPath);
          const mimeType = getMimeType(fullPath);
          return new Response(content, {
            headers: { "Content-Type": mimeType },
          });
        }
      }

      // 3. Serve index.html with injected config for SPA routes
      const indexPath = join(consoleAssetsDir, "index.html");
      if (existsSync(indexPath)) {
        const html = readFileSync(indexPath, "utf-8");
        const modifiedHtml = injectConfigIntoHtml(html, consolePath, config);

        return new Response(modifiedHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    }

    // 4. Return 404 if nothing matched
    return new Response("Not found", { status: 404 });
  };

  return { handler };
}
