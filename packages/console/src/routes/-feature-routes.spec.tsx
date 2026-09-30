import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  isNotFound,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConsoleFeatureUnavailable } from "@/components/ConsoleFeatureUnavailable";
import type { ConsoleFeatures } from "@/lib/console-features";
import { consoleFeaturesQueryKey } from "@/lib/console-features-api";

import { Route as ApiKeysRoute } from "./api-keys";
import { Route as InsightsRoute } from "./insights";
import { Route as DistributionRoute } from "./insights_.distribution";
import { Route as InstallationsRoute } from "./installations";

vi.mock("@/components/ui/sidebar", () => ({ SidebarTrigger: () => null }));

type FeatureGuard = (match: {
  readonly context: { readonly queryClient: QueryClient };
}) => Promise<void>;

/** A query client whose features query already holds `features`. */
const servedBy = (features: Partial<ConsoleFeatures>) => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(consoleFeaturesQueryKey, {
    features: {
      insights: false,
      insightsAnalytics: false,
      apiKeys: false,
      ...features,
    },
    remote: false,
  });
  return queryClient;
};

afterEach(cleanup);

describe.each([
  ["/insights", InsightsRoute.options, "insightsAnalytics", "Insights"],
  [
    "/insights/distribution",
    DistributionRoute.options,
    "insightsAnalytics",
    "Insights",
  ],
  ["/installations", InstallationsRoute.options, "insights", "Insights"],
  ["/api-keys", ApiKeysRoute.options, "apiKeys", "API keys"],
] as const)("%s", (path, options, feature, label) => {
  const guard = options.beforeLoad as unknown as FeatureGuard;

  it(`loads while ${feature} is on`, async () => {
    await expect(
      guard({ context: { queryClient: servedBy({ [feature]: true }) } }),
    ).resolves.toBeUndefined();
  });

  it(`is not found while ${feature} is off, naming the feature`, async () => {
    const thrown: unknown = await guard({
      context: {
        queryClient: servedBy({
          insights: feature !== "insights",
          apiKeys: feature !== "apiKeys",
        }),
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(isNotFound(thrown)).toBe(true);
    expect(thrown).toMatchObject({ data: { feature } });
    expect(options.notFoundComponent).toBe(ConsoleFeatureUnavailable);
  });

  it("shows the not-installed state in place of the page", async () => {
    const queryClient = servedBy({});
    const root = createRootRouteWithContext<{
      readonly queryClient: QueryClient;
    }>()({ component: Outlet });
    const route = createRoute({
      getParentRoute: () => root,
      path,
      beforeLoad: ({ context }) => guard({ context }),
      notFoundComponent: ConsoleFeatureUnavailable,
      component: () => <p>Feature page</p>,
    });
    const router = createRouter({
      context: { queryClient },
      history: createMemoryHistory({ initialEntries: [path] }),
      routeTree: root.addChildren([route]),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(`${label} not installed`)).toBeDefined();
    expect(screen.queryByText("Feature page")).toBeNull();
  });
});
