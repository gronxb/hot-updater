import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
// Import the route tree selected by the local or hosted Vite integration.
import { routeTree } from "virtual:hot-updater-console/route-tree";

import { getInsightsScrollRestorationKey } from "./routes/-installations-search";

// Create a new router instance
export const getRouter = () => {
  const queryClient = new QueryClient();
  const router = createRouter({
    routeTree,
    context: { queryClient },

    scrollRestoration: true,
    getScrollRestorationKey: getInsightsScrollRestorationKey,
    defaultPreloadStaleTime: 0,
  });

  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
};
