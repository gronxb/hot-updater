import { createFileRoute } from "@tanstack/react-router";

// Where iOS posts an iPhone's UDID, with no session and no reads: see
// nativeBuildDevice.ts.
export const Route = createFileRoute(
  "/_hot-updater/native-builds/$buildId/device-response",
)({
  server: {
    handlers: {
      ANY: async ({ params, request }) => {
        const { receiveDeviceResponse } =
          await import("@/lib/server/nativeBuildDevice");
        return receiveDeviceResponse(request, params.buildId);
      },
    },
  },
});
