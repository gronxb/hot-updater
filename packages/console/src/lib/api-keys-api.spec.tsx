import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
  ensureApiKeyRouteAccess,
  getApiKeyCapabilityQueryOptions,
} from "./api-keys-api";
import { getApiKeyCapabilityRpc } from "./api-keys-rpc";

vi.mock("./api-keys-rpc", () => ({
  createApiKeyRpc: vi.fn(),
  getApiKeyCapabilityRpc: vi.fn(),
  listApiKeysRpc: vi.fn(),
  revokeApiKeyRpc: vi.fn(),
}));

describe("API-key route access", () => {
  it("allows navigation only after provider capability is confirmed", async () => {
    vi.mocked(getApiKeyCapabilityRpc).mockResolvedValueOnce({
      apiKeys: true,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await expect(ensureApiKeyRouteAccess(queryClient)).resolves.toBeUndefined();
    expect(
      queryClient.getQueryData(getApiKeyCapabilityQueryOptions().queryKey),
    ).toEqual({ apiKeys: true });
  });

  it("redirects when the configured database has no key store", async () => {
    vi.mocked(getApiKeyCapabilityRpc).mockResolvedValueOnce({
      apiKeys: false,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await expect(ensureApiKeyRouteAccess(queryClient)).rejects.toMatchObject({
      options: { to: "/" },
    });
  });
});
