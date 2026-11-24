import { createFileRoute } from "@tanstack/react-router";

/** An artifact's manifest, by the artifact's ID, never a release's. */
export const Route = createFileRoute("/api/artifacts/$artifactId/download")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const { prepareConfig } = await import("@/lib/server/config.server");
        const { downloadBundle } = await import("@/lib/server/downloadBundle");
        const { core, storage } = await prepareConfig(request);
        return downloadBundle(params.artifactId, { core, storage });
      },
    },
  },
});
