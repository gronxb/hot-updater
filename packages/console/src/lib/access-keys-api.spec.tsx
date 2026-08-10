import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
  ensureManagedAccessKeyRouteAccess,
  getManagedAccessKeyCapabilityQueryOptions,
} from "./access-keys-api";
import { getManagedAccessKeyCapabilityRpc } from "./access-keys-rpc";

vi.mock("./access-keys-rpc", () => ({
  createManagedAccessKeyRpc: vi.fn(),
  getManagedAccessKeyCapabilityRpc: vi.fn(),
  listManagedAccessKeysRpc: vi.fn(),
  revokeManagedAccessKeyRpc: vi.fn(),
}));

describe("managed access-key route access", () => {
  it("allows navigation only after provider capability is confirmed", async () => {
    vi.mocked(getManagedAccessKeyCapabilityRpc).mockResolvedValueOnce({
      accessKeys: true,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await expect(
      ensureManagedAccessKeyRouteAccess(queryClient),
    ).resolves.toBeUndefined();
    expect(
      queryClient.getQueryData(
        getManagedAccessKeyCapabilityQueryOptions().queryKey,
      ),
    ).toEqual({ accessKeys: true });
  });

  it("redirects when the configured database has no key store", async () => {
    vi.mocked(getManagedAccessKeyCapabilityRpc).mockResolvedValueOnce({
      accessKeys: false,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await expect(
      ensureManagedAccessKeyRouteAccess(queryClient),
    ).rejects.toMatchObject({ options: { to: "/" } });
  });
});
