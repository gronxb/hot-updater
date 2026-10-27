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
  releases: vi.fn(),
  release: vi.fn(),
  events: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@/lib/release-adoption-rpc", () => ({
  listAdoptionReleasesRpc: mocks.releases,
  getAdoptionReleaseRpc: mocks.release,
  getBundleEventsRpc: mocks.events,
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
const HOUR = 3_600_000;
const release = (
  releaseId: string,
  deployedAtMs: number,
  overrides: {
    platform?: "ios" | "android";
    enabled?: boolean;
    live?: boolean;
  } = {},
) => ({
  releaseId,
  bundleId: `bundle-${releaseId}`,
  platform: "ios" as const,
  deployedAtMs,
  targetAppVersion: "1.0.0",
  enabled: true,
  live: true,
  revision: 1,
  ...overrides,
});
type EventsCall = {
  data: {
    platform: string;
    bundleId: string;
    type: string;
    window: string;
    endMs: number;
  };
};
/** Release health's reads so far, as "bundle type window". */
const eventReads = () =>
  mocks.events.mock.calls.map((call) => {
    const { data } = (call as [EventsCall])[0];
    return `${data.bundleId} ${data.type} ${data.window}`;
  });
function renderPage() {
  // Newest first: a rolled-back iOS bundle, then what devices get now, and
  // an older iOS bundle the newer one took every device from.
  mocks.releases.mockResolvedValue([
    release("release-new", 10 * HOUR, { enabled: false, live: false }),
    release("release-old", 2 * HOUR),
    release("release-android", (3 * HOUR) / 2, { platform: "android" }),
    release("release-oldest", HOUR, { live: false }),
  ]);
  mocks.release.mockResolvedValue({
    release: release("release-a", HOUR / 2),
    previous: release("release-before-a", HOUR / 4),
  });
  mocks.events.mockImplementation(async ({ data }: EventsCall) => ({
    bundleId: data.bundleId,
    type: data.type,
    measuredAtMs: data.endMs,
    points: [{ startMs: data.endMs - HOUR, events: 3 }],
    total: 3,
  }));
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
  it("keeps reporting periods independent while each filter applies to every panel as it changes", async () => {
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
    // Both cards start on 24 hours.
    expect(
      screen.getAllByRole("tab", { name: "24 hours", selected: true }),
    ).toHaveLength(2);
    expect(eventReads()).toContain("bundle-release-old LAUNCHED 24h");
    fireEvent.click(
      within(screen.getByRole("region", { name: "Release health" })).getByRole(
        "tab",
        { name: "7 days" },
      ),
    );
    await waitFor(() =>
      expect(eventReads()).toContain("bundle-release-old LAUNCHED 7d"),
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
        { name: "7 days", selected: true },
      ),
    ).toBeDefined();
    expect(mocks.releases).toHaveBeenCalledOnce();
    expect(
      screen
        .getByRole("progressbar", { name: "2.0.0 share" })
        .getAttribute("aria-valuetext"),
    ).toContain("30 installations");
    // Nothing narrowed yet: every report reads production, both platforms.
    expect(screen.queryByRole("button", { name: "Reset filters" })).toBeNull();
    await selectOption("Platform", "Android");
    await waitFor(() =>
      expect(mocks.usage).toHaveBeenLastCalledWith({
        data: { platform: "android", channel: "production", window: "30d" },
      }),
    );
    await selectOption("App version", "1.0.0");
    fireEvent.click(screen.getByRole("combobox", { name: /^Channel/ }));
    const search = await screen.findByRole("combobox", {
      name: "Search channels",
    });
    act(() => search.focus());
    fireEvent.input(search, {
      inputType: "insertText",
      target: { value: "bet" },
    });
    const beta = await screen.findByRole("option", { name: "beta" });
    await act(async () => {
      fireEvent.pointerDown(beta);
      fireEvent.click(beta);
    });
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
    // Each report names what it reads.
    expect(
      within(screen.getByRole("region", { name: "Release health" })).getByText(
        "beta",
      ),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("combobox", { name: /^Release/ }));
    const focus = await screen.findByRole("option", {
      name: /release-old ?Deployed/,
    });
    await act(async () => {
      fireEvent.pointerDown(focus);
      fireEvent.click(focus);
    });
    // The Release ID focuses Release health on it and the bundle before it.
    await waitFor(() =>
      expect(mocks.release).toHaveBeenCalledWith({
        data: {
          platform: "android",
          channel: "beta",
          releaseId: "release-old",
          withPrevious: true,
        },
      }),
    );
    await waitFor(() =>
      expect(eventReads()).toEqual(
        expect.arrayContaining([
          "bundle-release-a LAUNCHED 7d",
          "bundle-release-before-a LAUNCHED 7d",
        ]),
      ),
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
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      search: expect.objectContaining({
        channel: undefined,
        platform: undefined,
        appVersion: undefined,
        releaseId: undefined,
        bundles: undefined,
      }),
    });
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
    await waitFor(() => expect(mocks.events).toHaveBeenCalled());
    const eventCalls = mocks.events.mock.calls.length;
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh release health" }),
    );
    await waitFor(() =>
      expect(mocks.events.mock.calls.length).toBeGreaterThan(eventCalls),
    );
    expect(mocks.releases).toHaveBeenCalledTimes(2);
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

  it("follows the live bundle of each platform, reading each count once across the charts", async () => {
    mocks.usage.mockImplementation(async ({ data }: { data: AppUsageInput }) =>
      reportFor(data),
    );
    renderPage();
    const table = await screen.findByRole("table", {
      name: "Compared bundles",
    });
    await waitFor(() =>
      expect(within(table).getAllByRole("row")).toHaveLength(3),
    );
    expect(mocks.releases).toHaveBeenCalledExactlyOnceWith({
      data: { platform: "all", channel: "production" },
    });
    // Not the newest, rolled-back bundle: the live one of each platform,
    // each read on its own platform, downloads and launches over the same
    // hours.
    expect(eventReads().sort()).toEqual([
      "bundle-release-android DOWNLOADED 24h",
      "bundle-release-android LAUNCHED 24h",
      "bundle-release-old DOWNLOADED 24h",
      "bundle-release-old LAUNCHED 24h",
    ]);
    expect(
      new Set(
        mocks.events.mock.calls.map(
          ([{ data }]) => `${data.bundleId} ${data.platform}`,
        ),
      ),
    ).toEqual(
      new Set(["bundle-release-old ios", "bundle-release-android android"]),
    );
    expect(
      new Set(mocks.events.mock.calls.map(([{ data }]) => data.endMs)).size,
    ).toBe(1);

    // Crashes add each bundle's recoveries and reuse its launches.
    fireEvent.click(screen.getByRole("tab", { name: "Crashes" }));
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      search: { healthChart: "crashes" },
    });
    await waitFor(() => expect(mocks.events).toHaveBeenCalledTimes(6));
    expect(eventReads().slice(4).sort()).toEqual([
      "bundle-release-android RECOVERED 24h",
      "bundle-release-old RECOVERED 24h",
    ]);

    // Adding a bundle reads only it; the bundle list is not read again.
    const add = screen.getByRole("combobox", { name: "Add a bundle" });
    act(() => add.focus());
    fireEvent.input(add, {
      inputType: "insertText",
      target: { value: "oldest" },
    });
    const oldest = await screen.findByRole("option", {
      name: /release-oldest/,
    });
    await act(async () => {
      fireEvent.pointerDown(oldest);
      fireEvent.click(oldest);
    });
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      search: {
        healthChart: "crashes",
        bundles: "release-old,release-android,release-oldest",
      },
    });
    await waitFor(() => expect(mocks.events).toHaveBeenCalledTimes(8));
    expect(eventReads().slice(6).sort()).toEqual([
      "bundle-release-oldest LAUNCHED 24h",
      "bundle-release-oldest RECOVERED 24h",
    ]);
    expect(mocks.releases).toHaveBeenCalledOnce();
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
      "Each installation counts once, by its latest report since Sep 29, 00:00 UTC.",
    );
  });
});
