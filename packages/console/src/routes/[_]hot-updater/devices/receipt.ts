import { createFileRoute } from "@tanstack/react-router";

// This iPhone's kept proof, an HttpOnly cookie scoped to these routes: see
// iosDeviceCookie.ts. Every method needs the Console's session.
export const Route = createFileRoute("/_hot-updater/devices/receipt")({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        const [cookie, { iosDeviceViewer }, { requireConsoleAccess }, config] =
          await Promise.all([
            import("@/lib/server/iosDeviceCookie"),
            import("@/lib/server/iosDevices"),
            import("@/lib/server/auth.server"),
            import("@/lib/server/config.server"),
          ]);
        const loaded = () => config.prepareConfig(request);
        return cookie.handleIosDeviceReceipt(request, {
          viewer: async () =>
            iosDeviceViewer(
              await requireConsoleAccess(request),
              (await loaded()).config.deviceApprovers,
            ),
          core: async () => (await loaded()).core,
        });
      },
    },
  },
});
