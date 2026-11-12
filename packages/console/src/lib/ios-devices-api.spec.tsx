import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const { createLink } = vi.hoisted(() => ({
  createLink: vi.fn(),
}));
vi.mock("./ios-devices-rpc", () => ({
  approveIosDevice: vi.fn(),
  createIosDeviceProfileLink: createLink,
  getIosDevices: vi.fn(),
  getNativeBuildIpaDevices: vi.fn(),
  removeIosDevice: vi.fn(),
  renameIosDevice: vi.fn(),
}));

import {
  useIosDeviceProfileLinkQuery,
  useRequestThisIphoneMutation,
} from "./ios-devices-api";

const clientWrapper = () => {
  const client = new QueryClient();
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
};

type LinkInput = Parameters<typeof useIosDeviceProfileLinkQuery>[0];

describe("useIosDeviceProfileLinkQuery", () => {
  // The token signs its input: the callback takes the name, or the build to
  // return to, from the token. A token of another input is never this one's.
  it.each<[string, LinkInput, LinkInput]>([
    [
      "a renamed iPhone",
      { mode: "register", name: "Lead's iPhone" },
      { mode: "register", name: "Kim's iPhone" },
    ],
    [
      "another build",
      { mode: "identify", buildId: "build-1" },
      { mode: "identify", buildId: "build-2" },
    ],
  ])(
    "gives no token for %s until the server signs one for it",
    async (_, first, next) => {
      const pending: ((token: string) => void)[] = [];
      createLink.mockImplementation(
        ({ data }: { data: LinkInput }) =>
          new Promise((resolve) =>
            pending.push(() =>
              resolve({
                status: "issued",
                token: JSON.stringify(data),
                expiresAt: "2030-01-01",
              }),
            ),
          ),
      );
      const { result, rerender } = renderHook(
        ({ input }: { input: LinkInput }) =>
          useIosDeviceProfileLinkQuery(input),
        { initialProps: { input: first }, wrapper: clientWrapper() },
      );
      await waitFor(() => expect(pending).toHaveLength(1));
      await act(async () => pending[0]?.(""));
      await waitFor(() =>
        expect(result.current.data).toMatchObject({
          token: JSON.stringify(first),
        }),
      );

      rerender({ input: next });
      await waitFor(() => expect(pending).toHaveLength(2));

      // While the new token loads, the old one is gone.
      expect(result.current.data).toBeUndefined();
      await act(async () => pending[1]?.(""));
      await waitFor(() =>
        expect(result.current.data).toMatchObject({
          token: JSON.stringify(next),
        }),
      );
    },
  );
});

describe("useRequestThisIphoneMutation", () => {
  it("refreshes the build page's registry read before a caller's onSuccess runs, which IosInstall relies on", async () => {
    const events: string[] = [];
    let reads = 0;
    const fetch = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ device: { status: "pending" } }), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
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
        request: useRequestThisIphoneMutation("/console"),
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
    // Its own route, which alone the cookie is sent to, with the receipt.
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/console/_hot-updater/devices/request");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "Kim's iPhone",
      receipt: "r",
    });
    vi.unstubAllGlobals();
  });
});
