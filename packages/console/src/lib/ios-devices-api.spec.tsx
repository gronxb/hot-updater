import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const { requestAccess } = vi.hoisted(() => ({ requestAccess: vi.fn() }));
vi.mock("./ios-devices-rpc", () => ({
  approveIosDevice: vi.fn(),
  createIosDeviceProfileLink: vi.fn(),
  getIosDevices: vi.fn(),
  getNativeBuildIpaDevices: vi.fn(),
  removeIosDevice: vi.fn(),
  renameIosDevice: vi.fn(),
  requestIosDeviceAccess: requestAccess,
}));

import { useRequestIosDeviceAccessMutation } from "./ios-devices-api";

describe("useRequestIosDeviceAccessMutation", () => {
  it("refreshes the build page's registry read before a caller's onSuccess runs, which IosInstall relies on", async () => {
    const events: string[] = [];
    let reads = 0;
    requestAccess.mockResolvedValue({ device: { status: "pending" } });
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => ({
        eligibility: useQuery({
          queryKey: ["native-build-install-eligibility", "build", "udid"],
          queryFn: async () => {
            reads += 1;
            if (reads > 1) events.push("registry read again");
            return reads;
          },
        }),
        request: useRequestIosDeviceAccessMutation(),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.eligibility.data).toBe(1));

    await act(async () => {
      result.current.request.mutate(
        { receipt: "r", name: "Kim's iPhone" },
        { onSuccess: () => events.push("caller's onSuccess") },
      );
    });
    await waitFor(() => expect(events).toHaveLength(2));

    expect(events).toEqual(["registry read again", "caller's onSuccess"]);
  });
});
