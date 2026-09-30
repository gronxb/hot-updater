import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  useDeleteInsightsDataMutation,
  useInsightsInstallationsQuery,
  useReportingInstallationsQuery,
} from "./insights-api";
import { deleteInsightsDataRpc } from "./insights-deletion-rpc";
import {
  findInsightsInstallationsRpc,
  getReportingInstallationsRpc,
} from "./insights-rpc";

vi.mock("./insights-rpc", () => ({
  findInsightsInstallationsRpc: vi.fn(),
  getReportingInstallationsRpc: vi.fn(),
}));
vi.mock("./insights-deletion-rpc", () => ({ deleteInsightsDataRpc: vi.fn() }));

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
      platform: "ios",
      channel: "production",
      sinceMs: 0,
      beforeReceivedAtMs: 100,
      reportingInstallations: { count: 17, measuredAtMs: 100 },
      window: "7d",
    });

    const input = {
      platform: "ios",
      channel: "production",
      window: "7d",
    } as const;
    const { result } = renderHook(() => useReportingInstallationsQuery(input), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getReportingInstallationsRpc).toHaveBeenCalledWith({
      data: input,
    });
    expect(
      queryClient.getQueryData(["insights", "reporting-installations", input]),
    ).toMatchObject({ reportingInstallations: { count: 17 } });
    queryClient.clear();
  });
});

describe("Insights deletion", () => {
  afterEach(() => vi.clearAllMocks());

  it("repeats the bounded deletion until nothing remains, then refreshes Insights reads", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["insights", "installation", "install-1"], {});
    vi.mocked(deleteInsightsDataRpc)
      .mockResolvedValueOnce({
        deleted: { installations: 0, events: 500 },
        complete: false,
      })
      .mockResolvedValueOnce({
        deleted: { installations: 1, events: 20 },
        complete: true,
      });
    const { result } = renderHook(() => useDeleteInsightsDataMutation(), {
      wrapper: createWrapper(queryClient),
    });

    let deleted: unknown;
    await act(async () => {
      deleted = await result.current.mutateAsync({ installId: "install-1" });
    });

    expect(deleted).toEqual({ installations: 1, events: 520 });
    expect(deleteInsightsDataRpc).toHaveBeenCalledTimes(2);
    expect(deleteInsightsDataRpc).toHaveBeenCalledWith({
      data: { installId: "install-1" },
    });
    expect(
      queryClient.getQueryState(["insights", "installation", "install-1"])
        ?.isInvalidated,
    ).toBe(true);
    queryClient.clear();
  });

  it("stops after its call budget and says data remains", async () => {
    const queryClient = new QueryClient();
    vi.mocked(deleteInsightsDataRpc).mockResolvedValue({
      deleted: { installations: 0, events: 500 },
      complete: false,
    });
    const { result } = renderHook(() => useDeleteInsightsDataMutation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await expect(
        result.current.mutateAsync({ userId: "user-1" }),
      ).rejects.toThrow("some data remains. Delete again to finish.");
    });
    expect(deleteInsightsDataRpc).toHaveBeenCalledTimes(100);
    queryClient.clear();
  });
});
