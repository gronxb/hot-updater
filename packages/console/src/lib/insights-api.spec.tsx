import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  useInsightsInstallationsQuery,
  useReportingInstallationsQuery,
} from "./insights-api";
import {
  findInsightsInstallationsRpc,
  getReportingInstallationsRpc,
} from "./insights-rpc";

vi.mock("./insights-rpc", () => ({
  findInsightsInstallationsRpc: vi.fn(),
  getReportingInstallationsRpc: vi.fn(),
}));

const createWrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };

describe("lean Insights queries", () => {
  afterEach(() => vi.clearAllMocks());

  it("never turns an empty identity into an unfiltered installation query", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    renderHook(
      () => useInsightsInstallationsQuery({ identity: "", limit: 20 }, true),
      { wrapper: createWrapper(queryClient) },
    );
    await Promise.resolve();

    expect(findInsightsInstallationsRpc).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it("keys the reporting headline by the selected time window", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.mocked(getReportingInstallationsRpc).mockResolvedValue({
      activeInstallations: 17,
      asOfMs: 100,
      window: "7d",
    });

    const { result } = renderHook(() => useReportingInstallationsQuery("7d"), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getReportingInstallationsRpc).toHaveBeenCalledWith({
      data: { window: "7d" },
    });
    expect(
      queryClient.getQueryData(["insights", "reporting-installations", "7d"]),
    ).toMatchObject({ activeInstallations: 17 });
    queryClient.clear();
  });
});
