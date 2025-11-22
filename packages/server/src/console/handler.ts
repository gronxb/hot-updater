export interface ConsoleHandlerOptions {
  /**
   * Base path for console routes (e.g., "/console")
   * This value will be injected into the frontend HTML as window.__HOT_UPDATER_BASE_PATH__
   */
  basePath?: string;
  /**
   * Function to serve static files
   * If not provided, static files won't be served
   */
  serveStatic?: (path: string) => Promise<Response | null>;
}

export interface ConsoleHandler {
  handler: (request: Request) => Promise<Response>;
}

/**
 * Injects basePath into HTML by adding a script tag before </head>
 */
async function injectBasePathIntoHtml(
  response: Response,
  basePath: string,
): Promise<Response> {
  const html = await response.text();
  const scriptTag = `<script>window.__HOT_UPDATER_BASE_PATH__ = "${basePath}";</script>`;

  // Inject before </head>
  const modifiedHtml = html.replace("</head>", `${scriptTag}</head>`);

  return new Response(modifiedHtml, {
    status: response.status,
    headers: {
      ...Object.fromEntries(response.headers.entries()),
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

/**
 * Creates a console handler that serves static files with basePath injection.
 * API requests should be handled by the main handler.
 */
export function createConsoleHandler(
  options: ConsoleHandlerOptions,
): ConsoleHandler {
  const basePath = options.basePath ?? "";

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    let path = url.pathname;

    // Strip base path if present
    if (basePath && path.startsWith(basePath)) {
      path = path.slice(basePath.length) || "/";
    }

    // Handle static files if serveStatic is provided
    if (options.serveStatic) {
      // Serve assets
      if (path.startsWith("/assets/")) {
        const response = await options.serveStatic(path);
        if (response) {
          return response;
        }
      }

      // Serve index.html for all other routes (SPA fallback)
      // Inject basePath into HTML for frontend to use
      const indexResponse = await options.serveStatic("/index.html");
      if (indexResponse) {
        return injectBasePathIntoHtml(indexResponse, basePath);
      }
    }

    // If no static file handler or file not found
    return new Response("Not found", { status: 404 });
  };

  return { handler };
}
