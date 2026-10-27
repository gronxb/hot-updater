import { createFileRoute } from "@tanstack/react-router";

/**
 * Whether a request is a browser opening the URL as a page, as a phone does
 * after scanning a QR code, rather than a script fetching it.
 */
const isNavigation = (request: Request) =>
  request.headers.get("sec-fetch-mode") === "navigate" ||
  (request.headers.get("accept") ?? "").includes("text/html");

export const Route = createFileRoute("/api/native-builds/$buildId/download")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const { prepareConfig } = await import("@/lib/server/config.server");
        const { downloadNativeBuild } =
          await import("@/lib/server/nativeBuilds");
        let deps: Awaited<ReturnType<typeof prepareConfig>>;
        try {
          deps = await prepareConfig(request);
        } catch (error) {
          // A browser without a session opens the build's page instead,
          // where the console signs it in and returns to the build. The
          // path is relative to this one, so it stays under the console's
          // own path, wherever that is mounted.
          if (
            error instanceof Response &&
            error.status === 401 &&
            isNavigation(request)
          ) {
            return new Response(null, {
              headers: {
                "cache-control": "no-store",
                location: `../../../native-builds/${encodeURIComponent(params.buildId)}`,
              },
              status: 302,
            });
          }
          throw error;
        }
        return downloadNativeBuild(params.buildId, deps);
      },
    },
  },
});
