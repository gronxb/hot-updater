// @vitest-environment node

import { describe, expect, it } from "vitest";

import { toManagedAccessKeyView } from "./access-keys-rpc";

describe("managed access-key RPC output", () => {
  it("never serializes the provider lookup hash", () => {
    const view = toManagedAccessKeyView({
      createdAt: 1,
      enabled: true,
      hash: "provider-lookup-hash",
      id: `managed-client-${"a".repeat(43)}`,
      name: "Production app",
      prefix: "abcdef",
      revokedAt: null,
      role: "client",
    });

    expect(view).toEqual({
      createdAt: 1,
      enabled: true,
      id: `managed-client-${"a".repeat(43)}`,
      name: "Production app",
      prefix: "abcdef",
      revokedAt: null,
      role: "client",
    });
    expect("hash" in view).toBe(false);
  });
});
