import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../test-utils/test/inMemoryDatabasePlugin";
import {
  API_KEY_HEADER_NAME,
  authenticateApiKey,
  createApiKey,
  createApiKeyManagement,
  hashApiKey,
  normalizeApiKeyHeaderName,
  registerApiKey,
} from "./apiKeys";

const API_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

describe("API keys", () => {
  it("normalizes valid header names and rejects invalid names", () => {
    expect(normalizeApiKeyHeaderName()).toBe("x-api-key");
    expect(normalizeApiKeyHeaderName("X-Hot-Updater-Key")).toBe(
      "x-hot-updater-key",
    );
    expect(() => normalizeApiKeyHeaderName("")).toThrow(
      "clientAccess.headerName must be a valid header name.",
    );
    expect(() => normalizeApiKeyHeaderName("invalid header")).toThrow(
      "clientAccess.headerName must be a valid header name.",
    );
  });

  it("persists only the digest and metadata for a registered key", async () => {
    const database = createInMemoryDatabasePlugin();

    const created = await registerApiKey({
      apiKeys: database.models.apiKeys,
      apiKey: API_KEY,
      createdAtMs: 100,
      name: " Production app ",
    });

    expect(created.apiKey).toBe(API_KEY);
    expect(created.record).toEqual({
      created_at_ms: 100,
      id: expect.stringMatching(/^api-[A-Za-z0-9_-]{22}$/u),
      name: "Production app",
      prefix: "AQEBAQ",
      revoked_at_ms: null,
      role: "client",
    });
    expect(created.record).not.toHaveProperty("hash");
    expect(created.record.id).not.toContain(await hashApiKey(API_KEY));
    expect(await database.models.apiKeys.list()).toEqual([
      expect.objectContaining({ hash: await hashApiKey(API_KEY) }),
    ]);
    expect(JSON.stringify(await database.models.apiKeys.list())).not.toContain(
      API_KEY,
    );

    const registeredAgain = await registerApiKey({
      apiKeys: database.models.apiKeys,
      apiKey: API_KEY,
      createdAtMs: 200,
      name: "Ignored replacement name",
    });
    expect(registeredAgain.record).toEqual(created.record);
    expect(await database.models.apiKeys.list()).toHaveLength(1);
  });

  it("authenticates only active keys after the readiness check", async () => {
    const database = createInMemoryDatabasePlugin();
    const beforeLookup = vi.fn(async () => undefined);
    const { record } = await registerApiKey({
      apiKeys: database.models.apiKeys,
      apiKey: API_KEY,
      name: "App",
    });
    const request = new Request("https://example.com", {
      headers: { [API_KEY_HEADER_NAME]: API_KEY },
    });

    await expect(
      authenticateApiKey({
        apiKeys: database.models.apiKeys,
        beforeLookup,
        request,
      }),
    ).resolves.toBe(true);
    expect(beforeLookup).toHaveBeenCalledOnce();

    await database.models.apiKeys.revoke({
      id: record.id,
      revokedAtMs: Date.now(),
    });
    await expect(
      authenticateApiKey({
        apiKeys: database.models.apiKeys,
        request,
      }),
    ).resolves.toBe(false);
  });

  it("creates a canonical key and validates visible names", async () => {
    const database = createInMemoryDatabasePlugin();

    const created = await createApiKey({
      apiKeys: database.models.apiKeys,
      name: "App",
    });

    expect(created.apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(created.record.prefix).toBe(created.apiKey.slice(0, 6));
    await expect(
      registerApiKey({
        apiKeys: database.models.apiKeys,
        apiKey: API_KEY,
        name: "   ",
      }),
    ).rejects.toThrow("1-64 visible characters");
  });

  it("manages keys without exposing stored hashes", async () => {
    const database = createInMemoryDatabasePlugin();
    const beforeOperation = vi.fn(async () => undefined);
    const apiKeys = createApiKeyManagement({
      apiKeys: database.models.apiKeys,
      beforeOperation,
    });

    const created = await apiKeys.create({ name: "Production app" });
    expect(created.apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(created.record).not.toHaveProperty("hash");

    const records = await apiKeys.list();
    expect(records).toEqual([created.record]);
    expect(records[0]).not.toHaveProperty("hash");

    const revoked = await apiKeys.revoke({ id: created.record.id });
    expect(revoked).toMatchObject({
      id: created.record.id,
      revoked_at_ms: expect.any(Number),
    });
    expect(revoked).not.toHaveProperty("hash");
    expect(beforeOperation).toHaveBeenCalledTimes(3);
  });
});
