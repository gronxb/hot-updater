import { createFileRoute } from "@tanstack/react-router";

// The profile that reads an iPhone's UDID answers only to its capability,
// checked before anything is read: see iosDeviceProfile.ts.
export const Route = createFileRoute(
  "/_hot-updater/devices/device.mobileconfig",
)({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        const { serveDeviceProfile } =
          await import("@/lib/server/iosDeviceProfile");
        return serveDeviceProfile(request);
      },
    },
  },
});
