import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/native-builds/$buildId/download")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const { prepareConfig } = await import("@/lib/server/config.server");
        const { downloadNativeBuild } =
          await import("@/lib/server/nativeBuilds");
        const { core, storage } = await prepareConfig(request);
        return downloadNativeBuild(params.buildId, { core, storage });
      },
    },
  },
});
