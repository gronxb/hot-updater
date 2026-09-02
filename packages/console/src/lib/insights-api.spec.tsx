import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  insightsQueryKeys,
  useInsightsEventsQuery,
  useInsightsInstallationsQuery,
  useInsightsReportQuery,
} from "./insights-api";
import {
  getInsightsReportRpc,
  pageInsightsEventsRpc,
  pageInsightsInstallationsRpc,
} from "./insights-rpc";

vi.mock("./insights-rpc", () => ({
  getInsightsReportRpc: vi.fn(),
  pageInsightsEventsRpc: vi.fn(),
  pageInsightsInstallationsRpc: vi.fn(),
  pageInsightsReportRpc: vi.fn(),
}));

describe("Insights query hooks", () => {
  let client: QueryClient;
  let wrapper: ({ children }: PropsWithChildren) => React.ReactNode;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    wrapper = ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  });

  afterEach(() => client.clear());

  it("keys an unfiltered event page by its immutable cutoff and cursor", async () => {
    const input = {
      selector: { kind: "all" as const },
      beforeReceivedAtMs: 100,
      limit: 50,
      cursor: "next-page",
    };
    vi.mocked(pageInsightsEventsRpc).mockResolvedValue({
      state: "preparing",
    } as never);
    renderHook(() => useInsightsEventsQuery(input), { wrapper });
    await waitFor(() =>
      expect(pageInsightsEventsRpc).toHaveBeenCalledWith({ data: input }),
    );
    expect(insightsQueryKeys.events(input)).toEqual([
      "insights",
      "events",
      input,
    ]);
  });

  it("does not issue installation reads while the search is disabled", async () => {
    renderHook(
      () => useInsightsInstallationsQuery({ kind: "all", limit: 20 }, false),
      { wrapper },
    );
    await Promise.resolve();
    expect(pageInsightsInstallationsRpc).not.toHaveBeenCalled();
  });

  it("passes exact report inputs without converting them to offset queries", async () => {
    const input = {
      query: { kind: "activeOverview" as const, window: "30d" as const },
      minAsOfMs: 123,
    };
    vi.mocked(getInsightsReportRpc).mockResolvedValue({
      state: "preparing",
    } as never);
    renderHook(() => useInsightsReportQuery(input), { wrapper });
    await waitFor(() =>
      expect(getInsightsReportRpc).toHaveBeenCalledWith({ data: input }),
    );
  });
});
