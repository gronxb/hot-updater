// @vitest-environment node

import { describe, expect, it } from "vitest";

import { toClientAccessKeyView } from "./access-keys-rpc";

describe("client access-key RPC output", () => {
  it("never serializes the provider lookup hash", () => {
    const view = toClientAccessKeyView({
      created_at_ms: 1,
      hash: "provider-lookup-hash",
      id: `client-${"a".repeat(43)}`,
      name: "Production app",
      prefix: "abcdef",
      revoked_at_ms: null,
      role: "client",
    });

    expect(view).toEqual({
      created_at_ms: 1,
      id: `client-${"a".repeat(43)}`,
      name: "Production app",
      prefix: "abcdef",
      revoked_at_ms: null,
      role: "client",
    });
    expect("hash" in view).toBe(false);
  });
});
