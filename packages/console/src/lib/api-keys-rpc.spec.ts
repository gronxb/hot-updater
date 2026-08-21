// @vitest-environment node

import { describe, expect, it } from "vitest";

import { toApiKeyView } from "./api-keys-rpc";

describe("API-key RPC output", () => {
  it("never serializes the provider lookup hash", () => {
    const view = toApiKeyView({
      created_at_ms: 1,
      hash: "provider-lookup-hash",
      id: `api-${"a".repeat(43)}`,
      name: "Production app",
      prefix: "abcdef",
      revoked_at_ms: null,
      role: "client",
    });

    expect(view).toEqual({
      created_at_ms: 1,
      id: `api-${"a".repeat(43)}`,
      name: "Production app",
      prefix: "abcdef",
      revoked_at_ms: null,
      role: "client",
    });
    expect("hash" in view).toBe(false);
  });
});
