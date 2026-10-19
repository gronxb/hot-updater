import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
// Import the route tree selected by the local or hosted Vite integration.
import { routeTree } from "virtual:hot-updater-console/route-tree";

import { schemaMigrationQueryKey } from "./lib/schema-migration-api";
import { routeScrollRestorationKey } from "./lib/scroll-restoration";

// Create a new router instance
export const getRouter = () => {
  const queryClient: QueryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // A database that needs migrations stays refused until someone runs
        // them; the console's notice retries when asked.
        retry: (failures) =>
          failures < 3 && !queryClient.getQueryData(schemaMigrationQueryKey),
      },
    },
  });
  const router = createRouter({
    routeTree,
    context: { queryClient },

    scrollRestoration: true,
    getScrollRestorationKey: (location): string =>
      routeScrollRestorationKey(router, location),
    defaultPreloadStaleTime: 0,
  });

  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
};
