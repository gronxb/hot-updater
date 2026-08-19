import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/bundles/$bundleId/download")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const { prepareConfig } = await import("@/lib/server/config.server");
        const { downloadBundle } = await import("@/lib/server/downloadBundle");
        const { databaseClient, storagePlugin } = await prepareConfig(request);
        return downloadBundle(params.bundleId, {
          databaseClient,
          storagePlugin,
        });
      },
    },
  },
});
