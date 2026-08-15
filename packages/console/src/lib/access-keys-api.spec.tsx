import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
  ensureClientAccessKeyRouteAccess,
  getClientAccessKeyCapabilityQueryOptions,
} from "./access-keys-api";
import { getClientAccessKeyCapabilityRpc } from "./access-keys-rpc";

vi.mock("./access-keys-rpc", () => ({
  createClientAccessKeyRpc: vi.fn(),
  getClientAccessKeyCapabilityRpc: vi.fn(),
  listClientAccessKeysRpc: vi.fn(),
  revokeClientAccessKeyRpc: vi.fn(),
}));

describe("client access-key route access", () => {
  it("allows navigation only after provider capability is confirmed", async () => {
    vi.mocked(getClientAccessKeyCapabilityRpc).mockResolvedValueOnce({
      accessKeys: true,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await expect(
      ensureClientAccessKeyRouteAccess(queryClient),
    ).resolves.toBeUndefined();
    expect(
      queryClient.getQueryData(
        getClientAccessKeyCapabilityQueryOptions().queryKey,
      ),
    ).toEqual({ accessKeys: true });
  });

  it("redirects when the configured database has no key store", async () => {
    vi.mocked(getClientAccessKeyCapabilityRpc).mockResolvedValueOnce({
      accessKeys: false,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await expect(
      ensureClientAccessKeyRouteAccess(queryClient),
    ).rejects.toMatchObject({ options: { to: "/" } });
  });
});
