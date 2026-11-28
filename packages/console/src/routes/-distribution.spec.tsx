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
  release: vi.fn(),
  navigate: vi.fn(),
  initialSearch: {} as Record<string, unknown>,
}));
vi.mock("@/lib/insights-usage-rpc", () => ({
  getAppUsageReportRpc: mocks.usage,
}));
vi.mock("@/lib/api-rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-rpc")>()),
  getRelease: mocks.release,
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
  distributionSinceMs: 0,
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
      builtinBundleId: null,
      installations: 1,
    })),
    {
      appVersion: "1.0.0",
      platform: "ios",
      releaseId: null,
      builtinBundleId: null,
      installations: 2,
    },
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
  it("names each app version's built-in bundle by that version, apart from unknown bundles", async () => {
    const builtin = "019a0000-0000-7000-8000-000000000000";
    mocks.usage.mockResolvedValue({
      ...report,
      versions: [{ name: "1.0.0", installations: 10 }],
      bundleDistribution: [
        {
          appVersion: "1.0.0",
          platform: "ios",
          releaseId: null,
          builtinBundleId: builtin,
          installations: 6,
        },
        {
          appVersion: "1.0.0",
          platform: "ios",
          releaseId: "release-rollback",
          builtinBundleId: builtin,
          installations: 3,
        },
        {
          appVersion: "1.0.0",
          platform: "ios",
          releaseId: null,
          builtinBundleId: null,
          installations: 1,
        },
      ],
    });
    renderPage();
    const list = await screen.findByRole("list", {
      name: "Bundle distribution",
    });
    const [running, adopted, unknown] = within(list).getAllByRole("listitem");
    // Named by its app version, the full ID in its popover: never a piece of
    // the ID, whose tail is zeros in every build.
    expect(
      within(running!).getByRole("button", {
        name: `Built-in bundle · 1.0.0: copy built-in bundle ID ${builtin}`,
      }).textContent,
    ).toBe("Built-in bundle · 1.0.0");
    expect(running!.textContent).not.toContain("000000000000");
    expect(running!.textContent).not.toContain("019a0000");
    expect(within(running!).queryByRole("link")).toBeNull();
    expect(within(running!).queryByText("Unknown bundle")).toBeNull();
    expect(
      within(running!).getByRole("progressbar", {
        name: "Built-in bundle share in 1.0.0 on ios",
      }),
    ).toBeDefined();
    // A release that selected the built-in bundle links to it and still says
    // so, once its label is read.
    expect(
      await within(adopted!).findByRole("link", {
        name: "Review bundle release-rollback for app version 1.0.0",
      }),
    ).toBeDefined();
    const adoptedBuiltin = within(adopted!).getByRole("button", {
      name: `Built-in bundle · 1.0.0: copy built-in bundle ID ${builtin}`,
    });
    expect(adoptedBuiltin.textContent).toBe("Built-in bundle · 1.0.0");
    // Under the release's 44 px line on a phone, its 20 px line reaches
    // 12 px each way, 44 px tall, so its tap area meets the release tail's
    // rather than overlapping it.
    expect(adoptedBuiltin.className).toContain("text-sm");
    expect(adoptedBuiltin.className).toContain("after:-inset-y-3");
    expect(adoptedBuiltin.className).not.toContain("after:-inset-y-3.5");
    expect(within(unknown!).getByText("Unknown bundle")).toBeDefined();
    expect(within(unknown!).queryByText("Built-in bundle")).toBeNull();
    expect(mocks.release).toHaveBeenCalledWith({
      data: { releaseId: "release-rollback" },
    });
  });

  it("names each row's release by its label and ID, reading only the rows shown", async () => {
    const releaseId = "019a0000-0000-7000-8000-00000000abcd";
    mocks.release.mockResolvedValue({ id: releaseId, label: 7 });
    mocks.usage.mockResolvedValue({
      ...report,
      versions: [{ name: "1.0.0", installations: 3 }],
      bundleDistribution: [
        {
          appVersion: "1.0.0",
          platform: "ios",
          releaseId,
          builtinBundleId: null,
          installations: 3,
        },
      ],
    });
    renderPage();
    const link = () =>
      screen.getByRole("link", {
        name: `Review bundle ${releaseId} for app version 1.0.0`,
      });
    await waitFor(() => expect(link().textContent).toBe("v7"));
    expect(
      screen.getByRole("button", { name: `Copy ID ${releaseId}` }),
    ).toBeDefined();
    expect(mocks.release).toHaveBeenCalledTimes(1);
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
  it("counts each installation by its latest report since the period's first UTC day", async () => {
    mocks.usage.mockResolvedValue({
      ...report,
      sinceMs: Date.UTC(2026, 8, 29, 11),
      distributionSinceMs: Date.UTC(2026, 8, 29),
    });
    renderPage();
    await screen.findByRole("list", { name: "Bundle distribution" });

    fireEvent.click(
      screen.getByRole("button", {
        name: "How bundle distribution is counted",
      }),
    );
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "Each installation counts once, by its latest report since Sep 29, 00:00 UTC.",
    );
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
  it("takes 12 months for App usage only", () => {
    expect(
      validateDistributionSearch({ window: "12m", bundleWindow: "12m" }),
    ).toMatchObject({ window: "12m", bundleWindow: undefined });
  });
});
