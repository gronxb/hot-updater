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
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppUsageInput, AppUsageReport } from "@/lib/insights-usage";

const mocks = vi.hoisted(() => ({
  usage: vi.fn(),
  bundles: vi.fn(),
  downloadsReleases: vi.fn(),
  downloadsRelease: vi.fn(),
  downloads: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@/lib/insights-recovery-rpc", () => ({
  getRecoveryReportRpc: mocks.bundles,
  listDownloadsReleasesRpc: mocks.downloadsReleases,
  getDownloadsReleaseRpc: mocks.downloadsRelease,
  getReleaseDownloadsRpc: mocks.downloads,
}));
vi.mock("@/lib/insights-usage-rpc", () => ({
  getAppUsageReportRpc: mocks.usage,
}));
vi.mock("@/lib/api", () => ({
  useChannelsQuery: () => ({
    data: [{ name: "production" }, { name: "beta" }],
  }),
}));
vi.mock("@tanstack/react-router", async () => {
  const { useState } = await import("react");
  return {
    createFileRoute: () => (options: unknown) => ({
      options,
      useSearch: () => {
        const [search, setSearch] = useState({});
        mocks.navigate.mockImplementation(({ search }) => setSearch(search));
        return search;
      },
      useNavigate: () => mocks.navigate,
    }),
    Link: ({ children, to }: { children: ReactNode; to: string }) => (
      <a href={to}>{children}</a>
    ),
  };
});
vi.mock("@/components/features/insights/InsightsPageHeader", () => ({
  InsightsPageHeader: () => <a href="/installations">All events</a>,
}));
vi.mock("recharts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("recharts")>()),
  ResponsiveContainer: ({ children }: { children: ReactElement }) =>
    cloneElement(children, { width: 600, height: 192 } as object),
}));

import { Route } from "./insights";
const InsightsPage = Route.options.component;
if (!InsightsPage) throw new Error("Insights route component is required");
const reportFor = (input: AppUsageInput): AppUsageReport => {
  const count = input.appVersion
    ? 1
    : input.window === "24h"
      ? 3
      : input.window === "7d"
        ? 7
        : 30;
  return {
    bundleDistribution: [],
    activeInstallations: count,
    sinceMs: 0,
    distributionSinceMs: 0,
    beforeReceivedAtMs: 7_200_000,
    intervalMs: 3_600_000,
    truncated: false,
    appVersions: ["2.0.0", "1.0.0"],
    versions: [{ name: input.appVersion ?? "2.0.0", installations: count }],
    platforms: [
      {
        name: input.platform === "all" ? "ios" : input.platform,
        installations: count,
      },
    ],
    points: [
      { startMs: 0, installations: 1 },
      { startMs: 3_600_000, installations: count },
    ],
  };
};
function renderPage(
  bundles?: (call: { data: { releaseId?: string } }) => Promise<unknown>,
) {
  mocks.bundles.mockResolvedValue({
    downloads: 8,
    activeInstallations: 5,
    activeDays: 12,
    distribution: {
      coverage: { kind: "complete", sinceMs: 0 },
      measuredAtMs: 86_400_000,
      points: [],
    },
    failedLaunches: 1,
    points: [{ startMs: 0, dailyActiveInstallations: 12, failedLaunches: 1 }],
    startMs: 0,
    endMs: 7_200_000,
    measuredAtMs: 7_200_000,
    coverage: { kind: "complete", sinceMs: 0 },
  });
  if (bundles) mocks.bundles.mockImplementation(bundles);
  if (!InsightsPage) throw new Error("Insights route component is required");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <InsightsPage />
    </QueryClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function selectOption(label: string, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  const item = await screen.findByRole("option", { name: option });
  await act(async () => {
    fireEvent.pointerDown(item);
    fireEvent.click(item);
  });
}

describe("Insights dashboard", () => {
  it("keeps reporting periods independent while applying one filter form to both panels", async () => {
    mocks.usage.mockImplementation(async ({ data }: { data: AppUsageInput }) =>
      reportFor(data),
    );
    renderPage();
    expect(
      await screen.findByRole("region", { name: "DAU over 24 hours" }),
    ).toBeDefined();
    await waitFor(() =>
      expect(
        within(
          screen.getByRole("region", { name: "DAU over 24 hours" }),
        ).getByText("3"),
      ).toBeDefined(),
    );
    expect(
      screen.getAllByRole("tab", { name: "24 hours", selected: true }),
    ).toHaveLength(1);
    fireEvent.click(
      within(screen.getByRole("region", { name: "Release health" })).getByRole(
        "tab",
        { name: "24 hours" },
      ),
    );
    await waitFor(() =>
      expect(mocks.bundles).toHaveBeenLastCalledWith({
        data: { platform: "ios", channel: "production", window: "24h" },
      }),
    );
    expect(mocks.usage).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("region", { name: "DAU over 24 hours" }),
    ).toBeDefined();
    expect(
      within(screen.getByRole("region", { name: "App usage" })).getByRole(
        "tab",
        { name: "24 hours", selected: true },
      ),
    ).toBeDefined();
    fireEvent.click(
      within(screen.getByRole("region", { name: "App usage" })).getByRole(
        "tab",
        { name: "30 days" },
      ),
    );
    await waitFor(() =>
      expect(
        within(
          screen.getByRole("region", { name: "MAU over 30 days" }),
        ).getByText("30"),
      ).toBeDefined(),
    );
    expect(
      within(screen.getByRole("region", { name: "Release health" })).getByRole(
        "tab",
        { name: "24 hours", selected: true },
      ),
    ).toBeDefined();
    expect(mocks.bundles).toHaveBeenCalledTimes(2);
    expect(
      screen
        .getByRole("progressbar", { name: "2.0.0 share" })
        .getAttribute("aria-valuetext"),
    ).toContain("30 installations");
    const previousBundleCalls = mocks.bundles.mock.calls.length;
    const previousCalls = mocks.usage.mock.calls.length;
    await selectOption("Usage platform", "Android");
    await selectOption("App version", "1.0.0");
    act(() => screen.getByLabelText("Channel").focus());
    fireEvent.input(screen.getByLabelText("Channel"), {
      inputType: "insertText",
      target: { value: "bet" },
    });
    const beta = await screen.findByRole("option", { name: "beta" });
    await act(async () => {
      fireEvent.pointerDown(beta);
      fireEvent.click(beta);
    });
    await selectOption("Health platform", "Android");
    fireEvent.change(screen.getByLabelText("Release ID (optional)"), {
      target: { value: "release-a" },
    });
    expect(mocks.usage).toHaveBeenCalledTimes(previousCalls);
    expect(mocks.bundles).toHaveBeenCalledTimes(previousBundleCalls);
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() =>
      expect(mocks.usage).toHaveBeenLastCalledWith({
        data: {
          platform: "android",
          channel: "beta",
          appVersion: "1.0.0",
          window: "30d",
        },
      }),
    );
    await waitFor(() =>
      expect(mocks.bundles).toHaveBeenLastCalledWith({
        data: {
          platform: "android",
          channel: "beta",
          releaseId: "release-a",
          window: "24h",
        },
      }),
    );
    await waitFor(() =>
      expect(
        within(
          screen.getByRole("region", { name: "MAU over 30 days" }),
        ).getByText("1"),
      ).toBeDefined(),
    );
    expect(
      screen
        .getByRole("progressbar", { name: "Android share" })
        .getAttribute("aria-valuenow"),
    ).toBe("100");
    expect(
      within(screen.getByRole("region", { name: "Release health" }))
        .getByRole("link", { name: "Event history" })
        .getAttribute("href"),
    ).toBe("/installations");
    expect(
      screen.queryByRole("form", { name: "Release health filters" }),
    ).toBeNull();
  }, 15_000);

  it("recovers from a failed query and distinguishes empty and partially read history", async () => {
    mocks.usage.mockRejectedValueOnce(new Error("Offline"));
    mocks.usage.mockResolvedValue({
      ...reportFor({ platform: "all", channel: "production", window: "24h" }),
      activeInstallations: 0,
    });
    renderPage();
    expect(await screen.findByText("App usage unavailable")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry app usage" }));
    expect(await screen.findByText("No activity reported")).toBeDefined();
    const usageCalls = mocks.usage.mock.calls.length;
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh release health" }),
    );
    await waitFor(() => expect(mocks.bundles).toHaveBeenCalledTimes(2));
    expect(mocks.usage).toHaveBeenCalledTimes(usageCalls);
    mocks.usage.mockResolvedValue({
      ...reportFor({ platform: "all", channel: "production", window: "24h" }),
      truncated: true,
    });
    fireEvent.click(
      within(screen.getByRole("region", { name: "App usage" })).getByRole(
        "tab",
        { name: "7 days" },
      ),
    );
    expect(await screen.findByText("Partial history")).toBeDefined();
    expect(screen.getByText("≥3")).toBeDefined();
  });

  it("calculates distribution shares from exact distribution totals", async () => {
    mocks.usage.mockResolvedValue({
      ...reportFor({ platform: "all", channel: "production", window: "24h" }),
      activeInstallations: 4,
      versions: [{ name: "2.0.0", installations: 5 }],
      platforms: [{ name: "ios", installations: 5 }],
    });
    renderPage();

    expect(
      (
        await screen.findByRole("progressbar", { name: "2.0.0 share" })
      ).getAttribute("aria-valuetext"),
    ).toBe("5 installations, 100.0%");
    expect(
      screen
        .getByRole("progressbar", { name: "iOS share" })
        .getAttribute("aria-valuetext"),
    ).toBe("5 installations, 100.0%");
  });

  it("compares the newest bundles in the Downloads tab, reading each bundle once", async () => {
    const HOUR = 3_600_000;
    const release = (releaseId: string, deployedAtMs: number) => ({
      releaseId,
      deployedAtMs,
      message: null,
      targetAppVersion: "1.0.0",
    });
    mocks.usage.mockImplementation(async ({ data }: { data: AppUsageInput }) =>
      reportFor(data),
    );
    mocks.downloadsReleases.mockResolvedValue([
      release("release-new", 10 * HOUR),
      release("release-old", 2 * HOUR),
      release("release-oldest", HOUR),
    ]);
    mocks.downloads.mockImplementation(
      async ({ data }: { data: { releaseId: string; endMs: number } }) => ({
        releaseId: data.releaseId,
        measuredAtMs: data.endMs,
        coverage: { kind: "complete", sinceMs: 0 },
        points: [{ startMs: data.endMs - 6 * HOUR, downloads: 3 }],
        totalDownloads: 3,
      }),
    );
    renderPage();
    // Nothing reads downloads until the tab opens.
    await screen.findByRole("tab", { name: "Downloads" });
    expect(mocks.downloadsReleases).not.toHaveBeenCalled();
    expect(mocks.downloads).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Downloads" }));
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      search: { healthChart: "downloads" },
    });
    const table = await screen.findByRole("table", {
      name: "Compared bundles",
    });
    await waitFor(() =>
      expect(within(table).getAllByRole("row")).toHaveLength(3),
    );
    expect(mocks.downloadsReleases).toHaveBeenCalledExactlyOnceWith({
      data: { platform: "ios", channel: "production" },
    });
    // The newest two, over the same hours.
    expect(
      mocks.downloads.mock.calls.map(([{ data }]) => [
        data.releaseId,
        data.window,
      ]),
    ).toEqual([
      ["release-new", "7d"],
      ["release-old", "7d"],
    ]);
    const [first, second] = mocks.downloads.mock.calls.map(
      ([{ data }]) => data.endMs,
    );
    expect(first).toBe(second);

    await selectOption("Add a bundle", "release-…dest · Jan 1, 01:00 UTC");
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      search: {
        healthChart: "downloads",
        downloads: "release-new,release-old,release-oldest",
        downloadsFocus: undefined,
      },
    });
    await waitFor(() =>
      expect(
        within(
          screen.getByRole("table", { name: "Compared bundles" }),
        ).getAllByRole("row"),
      ).toHaveLength(4),
    );
    // Adding a bundle reads only it; the bundle list is not read again.
    expect(mocks.downloads).toHaveBeenCalledTimes(3);
    expect(mocks.downloads).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ releaseId: "release-oldest" }),
    });
    expect(mocks.downloadsReleases).toHaveBeenCalledOnce();
    expect(
      screen
        .getByRole("tab", { name: "Downloads" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("opens a bundle with the one deployed before it, reading past the newest only when needed", async () => {
    const HOUR = 3_600_000;
    const release = (releaseId: string, deployedAtMs: number) => ({
      releaseId,
      deployedAtMs,
      message: null,
      targetAppVersion: "1.0.0",
    });
    mocks.usage.mockImplementation(async ({ data }: { data: AppUsageInput }) =>
      reportFor(data),
    );
    mocks.downloadsReleases.mockResolvedValue([
      release("release-new", 10 * HOUR),
      release("release-old", 2 * HOUR),
      release("release-oldest", HOUR),
    ]);
    mocks.downloadsRelease.mockResolvedValue({
      release: release("release-far", HOUR / 2),
      previous: release("release-before-far", HOUR / 4),
    });
    mocks.downloads.mockImplementation(
      async ({ data }: { data: { releaseId: string; endMs: number } }) => ({
        releaseId: data.releaseId,
        measuredAtMs: data.endMs,
        coverage: { kind: "complete", sinceMs: 0 },
        points: [],
        totalDownloads: 0,
      }),
    );
    renderPage();
    await screen.findByRole("tab", { name: "Downloads" });
    // As View downloads on a bundle's Insights card links it.
    act(() =>
      mocks.navigate({
        search: { healthChart: "downloads", downloadsFocus: "release-old" },
      }),
    );
    const charted = () =>
      mocks.downloads.mock.calls.map(([{ data }]) => data.releaseId);
    await waitFor(() =>
      expect(charted()).toEqual(["release-old", "release-oldest"]),
    );
    // Both among the newest: nothing more to read.
    expect(mocks.downloadsRelease).not.toHaveBeenCalled();

    act(() =>
      mocks.navigate({
        search: { healthChart: "downloads", downloadsFocus: "release-far" },
      }),
    );
    await waitFor(() =>
      expect(charted().slice(2)).toEqual(["release-far", "release-before-far"]),
    );
    expect(mocks.downloadsRelease).toHaveBeenCalledExactlyOnceWith({
      data: {
        platform: "ios",
        channel: "production",
        releaseId: "release-far",
        withPrevious: true,
      },
    });
  });

  it("names the UTC day the distribution counts latest reports from", async () => {
    mocks.usage.mockResolvedValue({
      ...reportFor({ platform: "all", channel: "production", window: "24h" }),
      sinceMs: Date.UTC(2026, 8, 29, 11),
      distributionSinceMs: Date.UTC(2026, 8, 29),
    });
    renderPage();
    await screen.findByRole("progressbar", { name: "2.0.0 share" });

    fireEvent.click(
      screen.getByRole("button", { name: "How distribution is counted" }),
    );
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "latest matching report since Sep 29, 00:00 UTC. Latest reports are counted by UTC day.",
    );
  });
});
