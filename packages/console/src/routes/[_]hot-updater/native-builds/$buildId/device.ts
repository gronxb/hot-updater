import { createFileRoute } from "@tanstack/react-router";

// The page that shows an iPhone its UDID, with no session and no reads: see
// nativeBuildDevice.ts. A server route, so the Console's sign-in check never runs.
export const Route = createFileRoute(
  "/_hot-updater/native-builds/$buildId/device",
)({
  server: {
    handlers: {
      ANY: async ({ params, request }) => {
        const { serveDevicePage } =
          await import("@/lib/server/nativeBuildDevice");
        return serveDevicePage(request, params.buildId);
      },
    },
  },
});
