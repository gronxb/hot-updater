import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { validateDistributionSearch } from "@/lib/insights-search";
import type { AppUsageReport } from "@/lib/insights-usage";

const mocks = vi.hoisted(() => ({
  usage: vi.fn(),
  navigate: vi.fn(),
  initialSearch: {} as Record<string, unknown>,
}));
vi.mock("@/lib/insights-usage-rpc", () => ({
  getAppUsageReportRpc: mocks.usage,
}));
vi.mock("@/components/features/insights/InsightsPageHeader", () => ({
  InsightsPageHeader: () => null,
}));
vi.mock("@tanstack/react-router", async () => {
  const { useState } = await import("react");
  return {
    createFileRoute: () => (options: unknown) => ({
      options,
      useSearch: () => {
        const [search, setSearch] = useState(mocks.initialSearch);
        mocks.navigate.mockImplementation(({ search }) => setSearch(search));
        return search;
      },
      useNavigate: () => mocks.navigate,
    }),
    Link: ({
      to,
      search,
      children,
      ...props
    }: {
      to: string;
      search: Record<string, unknown>;
      children: ReactNode;
    }) => (
      <a
        href={`${to}?${new URLSearchParams(
          Object.entries(search)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)]),
        )}`}
        {...props}
      >
        {children}
      </a>
    ),
  };
});
import { Route } from "./insights_.distribution";
const report: AppUsageReport = {
  activeInstallations: 24,
  sinceMs: 0,
  beforeReceivedAtMs: 7_200_000,
  intervalMs: 3_600_000,
  truncated: false,
  appVersions: ["2.0.0", "1.0.0"],
  versions: [
    { name: "2.0.0", installations: 22 },
    { name: "1.0.0", installations: 2 },
  ],
  platforms: [{ name: "ios", installations: 24 }],
  points: [],
  bundleDistribution: [
    ...Array.from({ length: 22 }, (_, i) => ({
      appVersion: "2.0.0",
      platform: "ios" as const,
      releaseId: `bundle-${i}`,
      installations: 1,
    })),
    { appVersion: "1.0.0", platform: "ios", releaseId: null, installations: 2 },
  ],
};
function renderPage() {
  const Page = Route.options.component;
  if (!Page) throw new Error("Missing page");
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <Page />
    </QueryClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  mocks.initialSearch = {};
});

describe("Distribution details", () => {
  it("paginates all versions and narrows the same report without changing the reporting scope", async () => {
    mocks.initialSearch = {
      platform: "ios",
      channel: "beta",
      window: "7d",
      bundleWindow: "30d",
    };
    mocks.usage.mockResolvedValue(report);
    renderPage();
    const list = await screen.findByRole("list", {
      name: "Bundle distribution",
    });
    expect(within(list).getAllByRole("listitem")).toHaveLength(20);
    expect(screen.getByText("1–20 of 23")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("21–23 of 23")).toBeDefined();
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText("Unknown bundle")).toBeDefined();
    expect(
      screen.queryByRole("link", { name: /Review bundle Unknown/ }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("combobox", { name: "App version" }));
    const version = await screen.findByRole("option", { name: "1.0.0" });
    await act(async () => {
      fireEvent.pointerDown(version);
      fireEvent.click(version);
    });
    expect(screen.getByText("1–1 of 1")).toBeDefined();
    expect(
      screen
        .getByRole("progressbar", {
          name: "Unknown bundle share in 1.0.0 on ios",
        })
        .getAttribute("aria-valuenow"),
    ).toBe("100");
    expect(mocks.usage).toHaveBeenCalledTimes(1);
    const back = screen
      .getByRole("link", { name: "Back to overview" })
      .getAttribute("href");
    expect(back).toContain("window=7d");
    expect(back).toContain("bundleWindow=30d");
    expect(back).toContain("channel=beta");
    fireEvent.click(screen.getByRole("tab", { name: "30 days" }));
    await waitFor(() =>
      expect(mocks.usage).toHaveBeenLastCalledWith({
        data: {
          platform: "ios",
          channel: "beta",
          window: "30d",
          appVersion: undefined,
        },
      }),
    );
  });
  it("keeps retry and empty states usable and labels partial counts", async () => {
    mocks.usage.mockRejectedValueOnce(new Error("Offline"));
    mocks.usage.mockResolvedValue({ ...report, bundleDistribution: [] });
    renderPage();
    expect(await screen.findByText("Distribution unavailable")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry distribution" }));
    expect(await screen.findByText("No bundles reported")).toBeDefined();
    mocks.usage.mockResolvedValue({ ...report, truncated: true });
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh distribution" }),
    );
    expect(await screen.findByText("Partial history")).toBeDefined();
    expect(screen.getByText("≥24")).toBeDefined();
  });
  it("drops malformed URL values without losing independent periods or version text", () => {
    expect(
      validateDistributionSearch({
        platform: "web",
        window: "forever",
        bundleWindow: "30d",
        page: -1,
        version: "2.0.0-rc+qa",
        channel: " ",
      }),
    ).toEqual({
      platform: undefined,
      channel: undefined,
      appVersion: undefined,
      window: undefined,
      bundleWindow: "30d",
      page: undefined,
      version: "2.0.0-rc+qa",
    });
  });
});
