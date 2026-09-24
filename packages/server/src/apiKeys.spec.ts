import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";
import { describe, expect, it } from "vitest";

import {
  API_KEY_HEADER_NAME,
  authenticateApiKey,
  createApiKey,
  createApiKeyManagement,
  hashApiKey,
  normalizeApiKeyHeaderName,
  provisionApiKey,
  registerApiKey,
} from "./apiKeys";
import { createDatabaseEngine } from "./database/database";
import { resolveSchema } from "./database/resolveSchema";
import { apiKeysSchema, createApiKeyModel } from "./plugins/api-keys";

/** The api-keys plugin's table model on an empty in-memory database. */
const createModel = () => {
  const module = { id: "apiKeys", schema: apiKeysSchema } as const;
  return createApiKeyModel(
    createDatabaseEngine({
      adapter: createMemoryAdapter(),
      schema: resolveSchema([module]),
    }).database(module),
  );
};

const API_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

describe("API keys", () => {
  it("normalizes valid header names and rejects invalid names", () => {
    expect(normalizeApiKeyHeaderName()).toBe("x-api-key");
    expect(normalizeApiKeyHeaderName("X-Hot-Updater-Key")).toBe(
      "x-hot-updater-key",
    );
    expect(() => normalizeApiKeyHeaderName("")).toThrow(
      "apiKeys({ headerName }) must name a valid header.",
    );
    expect(() => normalizeApiKeyHeaderName("invalid header")).toThrow(
      "apiKeys({ headerName }) must name a valid header.",
    );
  });

  it("persists only the digest and metadata for a registered key", async () => {
    const model = createModel();

    const created = await registerApiKey({
      apiKeys: model,
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
    expect(await model.list()).toEqual([
      expect.objectContaining({ hash: await hashApiKey(API_KEY) }),
    ]);
    expect(JSON.stringify(await model.list())).not.toContain(API_KEY);

    const registeredAgain = await registerApiKey({
      apiKeys: model,
      apiKey: API_KEY,
      createdAtMs: 200,
      name: "Ignored replacement name",
    });
    expect(registeredAgain.record).toEqual(created.record);
    expect(await model.list()).toHaveLength(1);
  });

  it("authenticates only active keys", async () => {
    const model = createModel();
    const { record } = await registerApiKey({
      apiKeys: model,
      apiKey: API_KEY,
      name: "App",
    });
    const request = new Request("https://example.com", {
      headers: { [API_KEY_HEADER_NAME]: API_KEY },
    });

    await expect(
      authenticateApiKey({
        apiKeys: model,
        request,
      }),
    ).resolves.toBe(true);

    await model.revoke({
      id: record.id,
      revokedAtMs: Date.now(),
    });
    await expect(
      authenticateApiKey({
        apiKeys: model,
        request,
      }),
    ).resolves.toBe(false);
  });

  it("creates a canonical key and validates visible names", async () => {
    const model = createModel();

    const created = await createApiKey({
      apiKeys: model,
      name: "App",
    });

    expect(created.apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(created.record.prefix).toBe(created.apiKey.slice(0, 6));
    await expect(
      registerApiKey({
        apiKeys: model,
        apiKey: API_KEY,
        name: "   ",
      }),
    ).rejects.toThrow("1-64 visible characters");
  });

  it("provisions a new key once and reuses an existing managed key", async () => {
    const model = createModel();

    const created = await provisionApiKey({
      apiKeys: model,
      name: "Managed init",
    });
    const reused = await provisionApiKey({
      apiKeys: model,
      existingApiKey: created.apiKey,
      name: "Managed init rerun",
    });

    expect(reused).toEqual(created);
    expect(await model.list()).toHaveLength(1);
  });

  it("manages keys without exposing stored hashes", async () => {
    const model = createModel();
    const apiKeys = createApiKeyManagement({ apiKeys: model });

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
  });
});
