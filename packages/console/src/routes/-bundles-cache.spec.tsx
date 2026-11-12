import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getChannels, getReleaseFold, getReleases } from "@/lib/api-rpc";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
}));

// The real query hooks over a real cache; only the server functions are fake.
vi.mock("@/lib/api-rpc", () => ({
  getBundle: vi.fn(),
  getBundleChildCounts: vi.fn(() => Promise.resolve({})),
  getBundleChildren: vi.fn(),
  getChannels: vi.fn(),
  getReleaseFold: vi.fn(),
  getReleases: vi.fn(),
}));
vi.mock("@/lib/bundle-activity", () => ({
  useBundleActivityQuery: () => ({ data: {} }),
}));
vi.mock("@/lib/console-features-api", () => ({
  useConsoleFeatures: () => ({
    data: { features: { insights: false }, remote: false },
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useNavigate: () => vi.fn(),
    useSearch: mocks.search,
  }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@/components/features/channels/ChannelManagementDialog", () => ({
  ChannelManagementDialog: () => null,
}));
vi.mock("@/components/features/releases/ReleaseEditorSheet", () => ({
  ReleaseEditorSheet: () => null,
}));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => null,
}));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

import { Route } from "./index";

const BundlesPage = (Route as unknown as { readonly component: ComponentType })
  .component;

const staging = {
  bundle_id: null,
  channel_id: "channel-staging",
  created_at_ms: Date.UTC(2026, 6, 18),
  enabled: true,
  fingerprint_hash: null,
  id: "release-staging",
  kind: "BUILT_IN",
  message: null,
  operation: "DEPLOY",
  platform: "android",
  revision: 1,
  rollout_cohort_count: 1_000,
  scope_key: "scope-1",
  should_force_update: false,
  source_release_id: null,
  strategy: "APP_VERSION",
  target_app_version: "1.0.0",
  target_cohorts: [],
  updated_at_ms: Date.UTC(2026, 6, 18),
  currentlyUnreachable: false,
};

describe("BundlesPage over a cached every-channel page", () => {
  let queryClient: QueryClient;
  const page = () => (
    <QueryClientProvider client={queryClient}>
      <BundlesPage />
    </QueryClientProvider>
  );

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.mocked(getReleases).mockResolvedValue({
      entries: [
        { kind: "row", row: staging },
        { kind: "fold", count: 1, more: false, to: "release-0" },
      ],
    } as never);
  });
  afterEach(() => {
    cleanup();
    queryClient.clear();
    vi.clearAllMocks();
  });

  it.each([
    ["fails", () => Promise.reject(new Error("Offline"))],
    ["has not answered", () => new Promise(() => {})],
  ])(
    "shows and reads none of it on the default URL while the channel list %s",
    async (_, channels) => {
      vi.mocked(getChannels).mockResolvedValueOnce([
        { id: "channel-production", name: "production" },
        { id: "channel-staging", name: "staging" },
      ] as never);
      mocks.search.mockReturnValue({ channels: "all" });
      const view = render(page());
      await screen.findByRole("row", { name: "Open bundle release-staging" });
      expect(vi.mocked(getReleases)).toHaveBeenCalledTimes(1);

      // The channel list is read again, and the URL drops channels=all.
      vi.mocked(getChannels).mockImplementation(channels as never);
      queryClient.removeQueries({ queryKey: ["channels"] });
      mocks.search.mockReturnValue({});
      view.rerender(page());

      await waitFor(() =>
        expect(
          screen.queryByRole("row", { name: "Open bundle release-staging" }),
        ).toBeNull(),
      );
      expect(
        screen.queryByRole("button", { name: "1 unreachable bundle" }),
      ).toBeNull();
      expect(vi.mocked(getReleases)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(getReleaseFold)).not.toHaveBeenCalled();
    },
  );
});
