import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/bundles/$bundleId/download")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { prepareConfig } = await import("@/lib/server/config.server");
        const { downloadBundle } = await import("@/lib/server/downloadBundle");
        const { databaseClient, storagePlugin } = await prepareConfig();
        return downloadBundle(params.bundleId, {
          databaseClient,
          storagePlugin,
        });
      },
    },
  },
});
