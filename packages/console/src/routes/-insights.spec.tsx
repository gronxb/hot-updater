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
  navigate: vi.fn(),
}));
vi.mock("@/lib/insights-recovery-rpc", () => ({
  getRecoveryReportRpc: mocks.bundles,
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
function renderPage() {
  mocks.bundles.mockResolvedValue({
    sinceMs: 0,
    beforeReceivedAtMs: 7_200_000,
    intervalMs: 3_600_000,
    truncated: false,
    unattributedInstallations: 0,
    pendingInstallations: 0,
    downloadedInstallations: 0,
    series: [],
  });
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
  it("keeps reporting periods independent while applying scope filters to both panels", async () => {
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
    ).toHaveLength(2);
    fireEvent.click(
      within(screen.getByRole("region", { name: "Bundle activity" })).getByRole(
        "tab",
        { name: "7 days" },
      ),
    );
    await waitFor(() =>
      expect(mocks.bundles).toHaveBeenLastCalledWith({
        data: { platform: "all", channel: "production", window: "7d" },
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
      within(screen.getByRole("region", { name: "Bundle activity" })).getByRole(
        "tab",
        { name: "7 days", selected: true },
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
    await selectOption("Platform", "Android");
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
          appVersion: "1.0.0",
          window: "7d",
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
      within(screen.getByRole("region", { name: "Bundle activity" }))
        .getByRole("link", { name: "All events" })
        .getAttribute("href"),
    ).toBe("/installations");
  });

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
      screen.getByRole("button", { name: "Refresh bundle activity" }),
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
});
