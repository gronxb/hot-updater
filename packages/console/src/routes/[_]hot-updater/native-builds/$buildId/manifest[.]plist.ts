import { createFileRoute } from "@tanstack/react-router";

// What iOS installs a build from. Its token is all it answers to, checked
// before any read: see nativeBuildInstall.ts.
export const Route = createFileRoute(
  "/_hot-updater/native-builds/$buildId/manifest.plist",
)({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const [{ serveNativeBuildManifest }, { loadConsole }] =
          await Promise.all([
            import("@/lib/server/nativeBuildInstall"),
            import("@/lib/server/config.server"),
          ]);
        return serveNativeBuildManifest(request, params.buildId, () =>
          loadConsole(request),
        );
      },
    },
  },
});
