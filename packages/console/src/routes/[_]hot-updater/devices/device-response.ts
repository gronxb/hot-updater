import { createFileRoute } from "@tanstack/react-router";

// Where iOS posts an iPhone's UDID, with no session: its capability is checked
// before the body is read, and only a register capability writes, through the
// Console's own assembly. See iosDeviceProfile.ts.
export const Route = createFileRoute("/_hot-updater/devices/device-response")({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        const [{ receiveDeviceResponse }, { loadConsole }] = await Promise.all([
          import("@/lib/server/iosDeviceProfile"),
          import("@/lib/server/config.server"),
        ]);
        return receiveDeviceResponse(request, async () =>
          (await loadConsole(request)).core,
        );
      },
    },
  },
});
