import { createFileRoute } from "@tanstack/react-router";

import { NATIVE_BUILD_DOWNLOAD_TOKEN_PARAM } from "@/lib/native-builds";

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
        const { loadConsole, prepareConfig } =
          await import("@/lib/server/config.server");
        const { downloadNativeBuild } =
          await import("@/lib/server/nativeBuilds");
        // A request with a signed link answers to its token alone, signed
        // in or not, and reaches this route and the install manifest's, for
        // this one build.
        const token = new URL(request.url).searchParams.get(
          NATIVE_BUILD_DOWNLOAD_TOKEN_PARAM,
        );
        if (token !== null) {
          const { refuseNativeBuildDownloadToken } =
            await import("@/lib/server/nativeBuildDownloadLink");
          return (
            (await refuseNativeBuildDownloadToken(
              request,
              params.buildId,
              token,
            )) ??
            downloadNativeBuild(params.buildId, await loadConsole(request))
          );
        }
        let deps: Awaited<ReturnType<typeof prepareConfig>>;
        try {
          deps = await prepareConfig(request);
        } catch (error) {
          // A browser without a session opens the build's page instead,
          // where the console signs it in and returns to this download
          // (`returnTo`, relative to that page). Both paths are relative,
          // so they stay under the console's own path, wherever that is
          // mounted; sign-in takes `returnTo` only on the console's origin.
          if (
            error instanceof Response &&
            error.status === 401 &&
            isNavigation(request)
          ) {
            const buildId = encodeURIComponent(params.buildId);
            const returnTo = encodeURIComponent(
              `../api/native-builds/${buildId}/download`,
            );
            return new Response(null, {
              headers: {
                "cache-control": "no-store",
                location: `../../../native-builds/${buildId}?returnTo=${returnTo}`,
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
