import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";

import { useBundleSigningInspectionQuery } from "./bundle-signing-api";
import { getBundleSigningInspectionRpc } from "./bundle-signing-rpc";

vi.mock("./bundle-signing-rpc", () => ({
  getBundleSigningInspectionRpc: vi.fn(),
}));

describe("bundle signing inspection query", () => {
  it("loads the read-only signing inspection once", async () => {
    vi.mocked(getBundleSigningInspectionRpc).mockResolvedValueOnce({
      algorithm: "RSA-SHA256",
      fingerprint: "a".repeat(64),
      provider: "Local file",
      publicKey: "-----BEGIN PUBLIC KEY-----\npublic\n-----END PUBLIC KEY-----",
      status: "enabled",
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useBundleSigningInspectionQuery(), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.status).toBe("enabled");
    expect(getBundleSigningInspectionRpc).toHaveBeenCalledOnce();
    queryClient.clear();
  });
});
