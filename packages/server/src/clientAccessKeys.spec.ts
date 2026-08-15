import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../test-utils/test/inMemoryDatabasePlugin";
import {
  authenticateClientAccessKey,
  CLIENT_ACCESS_KEY_HEADER_NAME,
  createClientAccessKey,
  hashClientAccessKey,
  registerClientAccessKey,
} from "./clientAccessKeys";

const API_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

describe("client access keys", () => {
  it("persists only the digest and metadata for a registered key", async () => {
    const database = createInMemoryDatabasePlugin();

    const created = await registerClientAccessKey({
      apiKey: API_KEY,
      clientAccessKeys: database.models.clientAccessKeys,
      createdAtMs: 100,
      name: " Production app ",
    });

    expect(created.apiKey).toBe(API_KEY);
    expect(created.record).toEqual({
      created_at_ms: 100,
      hash: await hashClientAccessKey(API_KEY),
      id: `client-${await hashClientAccessKey(API_KEY)}`,
      name: "Production app",
      prefix: "AQEBAQ",
      revoked_at_ms: null,
      role: "client",
    });
    expect(
      JSON.stringify(await database.models.clientAccessKeys.list()),
    ).not.toContain(API_KEY);
  });

  it("authenticates only active keys after the readiness check", async () => {
    const database = createInMemoryDatabasePlugin();
    const beforeLookup = vi.fn(async () => undefined);
    const { record } = await registerClientAccessKey({
      apiKey: API_KEY,
      clientAccessKeys: database.models.clientAccessKeys,
      name: "App",
    });
    const request = new Request("https://example.com", {
      headers: { [CLIENT_ACCESS_KEY_HEADER_NAME]: API_KEY },
    });

    await expect(
      authenticateClientAccessKey({
        beforeLookup,
        clientAccessKeys: database.models.clientAccessKeys,
        request,
      }),
    ).resolves.toBe(true);
    expect(beforeLookup).toHaveBeenCalledOnce();

    await database.models.clientAccessKeys.revoke({
      id: record.id,
      revokedAtMs: Date.now(),
    });
    await expect(
      authenticateClientAccessKey({
        clientAccessKeys: database.models.clientAccessKeys,
        request,
      }),
    ).resolves.toBe(false);
  });

  it("creates a canonical key and validates visible names", async () => {
    const database = createInMemoryDatabasePlugin();

    const created = await createClientAccessKey({
      clientAccessKeys: database.models.clientAccessKeys,
      name: "App",
    });

    expect(created.apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(created.record.prefix).toBe(created.apiKey.slice(0, 6));
    await expect(
      registerClientAccessKey({
        apiKey: API_KEY,
        clientAccessKeys: database.models.clientAccessKeys,
        name: "   ",
      }),
    ).rejects.toThrow("1-64 visible characters");
  });
});
