import { createFileRoute } from "@tanstack/react-router";

// The profile that reads an iPhone's UDID takes no session and reads nothing:
// see nativeBuildDevice.ts.
export const Route = createFileRoute(
  "/_hot-updater/native-builds/$buildId/device.mobileconfig",
)({
  server: {
    handlers: {
      ANY: async ({ params, request }) => {
        const { serveDeviceProfile } =
          await import("@/lib/server/nativeBuildDevice");
        return serveDeviceProfile(request, params.buildId);
      },
    },
  },
});
