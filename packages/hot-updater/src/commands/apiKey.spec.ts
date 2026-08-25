import { createApiKey } from "@hot-updater/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleApiKeyCreate,
  handleApiKeyList,
  handleApiKeyRevoke,
} from "./apiKey";
import {
  loadHotUpdater,
  type ApiKeyManagementAPI,
  type ApiKeyMetadata,
  type LoadHotUpdaterResult,
} from "./utils/load-hot-updater";

const { log, printBanner } = vi.hoisted(() => ({
  log: {
    error: vi.fn(),
    message: vi.fn(),
    warn: vi.fn(),
  },
  printBanner: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  p: {
    confirm: vi.fn(),
    isCancel: vi.fn(() => false),
    log,
  },
}));

vi.mock("@/utils/printBanner", () => ({ printBanner }));

vi.mock("./utils/load-hot-updater", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils/load-hot-updater")>()),
  loadHotUpdater: vi.fn(),
}));

type ApiKeyModel = Parameters<typeof createApiKey>[0]["apiKeys"];
type ApiKeyRow = Parameters<ApiKeyModel["create"]>[0];

const withoutHash = ({ hash: _hash, ...record }: ApiKeyRow): ApiKeyMetadata =>
  record;

const createApiKeyHarness = () => {
  const rows: ApiKeyRow[] = [];
  const plaintextKeys: string[] = [];
  const model: ApiKeyModel = {
    create: vi.fn(async (row) => {
      if (rows.some((item) => item.hash === row.hash)) return "existing";
      rows.push(row);
      return "created";
    }),
    findByHash: vi.fn(
      async (hash) => rows.find((row) => row.hash === hash) ?? null,
    ),
    list: vi.fn(async () => rows),
    revoke: vi.fn(async ({ id, revokedAtMs }) => {
      const index = rows.findIndex((row) => row.id === id);
      const current = rows[index];
      if (current === undefined) return null;
      const revoked = { ...current, revoked_at_ms: revokedAtMs };
      rows[index] = revoked;
      return revoked;
    }),
  };
  const apiKeys: ApiKeyManagementAPI = {
    async create({ name }) {
      const created = await createApiKey({ apiKeys: model, name });
      plaintextKeys.push(created.apiKey);
      return created;
    },
    async list() {
      return (await model.list()).map(withoutHash);
    },
    async revoke({ id }) {
      const revoked = await model.revoke({ id, revokedAtMs: Date.now() });
      return revoked === null ? null : withoutHash(revoked);
    },
  };
  return { apiKeys, plaintextKeys, rows };
};

const loadedConfig = (
  apiKeys: ApiKeyManagementAPI | undefined,
  dispose = vi.fn(async () => {}),
): LoadHotUpdaterResult => ({
  absoluteConfigPath: "/repo/hot-updater.config.ts",
  adapterName: "kysely",
  dispose,
  hotUpdater: {
    adapterName: "kysely",
    apiKeys,
    authorityId: "default",
  },
});

describe("API key commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a key, persists only its hash, and prints plaintext once", async () => {
    const { apiKeys, plaintextKeys, rows } = createApiKeyHarness();
    const dispose = vi.fn(async () => {});
    vi.mocked(loadHotUpdater).mockResolvedValue(loadedConfig(apiKeys, dispose));

    await handleApiKeyCreate("Production app");

    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.hash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const apiKey = plaintextKeys[0];
    expect(apiKey).toBeDefined();
    const message = String(log.message.mock.calls[0]?.[0]);
    expect(message).toContain(apiKey);
    expect(row?.hash).not.toBe(apiKey);
    expect(JSON.stringify(row)).not.toContain(apiKey);
    const allOutput = JSON.stringify([
      ...log.message.mock.calls,
      ...log.warn.mock.calls,
    ]);
    expect(allOutput.split(apiKey!).length - 1).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(
      "Save this API key now. It will not be shown again.",
    );
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("lists JSON metadata without a hash or plaintext key", async () => {
    const { apiKeys } = createApiKeyHarness();
    const created = await apiKeys.create({ name: "Production app" });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(loadHotUpdater).mockResolvedValue(loadedConfig(apiKeys));

    await handleApiKeyList({ json: true });

    const json = String(output.mock.calls[0]?.[0]);
    expect(JSON.parse(json)).toEqual([created.record]);
    expect(json).not.toContain("hash");
    expect(json).not.toContain(created.apiKey);
    expect(printBanner).not.toHaveBeenCalled();
  });

  it("revokes an API key by id", async () => {
    const { apiKeys } = createApiKeyHarness();
    const created = await apiKeys.create({ name: "Production app" });
    const revoke = vi.spyOn(apiKeys, "revoke");
    vi.mocked(loadHotUpdater).mockResolvedValue(loadedConfig(apiKeys));

    await handleApiKeyRevoke(created.record.id, { yes: true });

    expect(revoke).toHaveBeenCalledWith({ id: created.record.id });
    await expect(apiKeys.list()).resolves.toMatchObject([
      { id: created.record.id, revoked_at_ms: expect.any(Number) },
    ]);
  });

  it("disposes the config when key creation fails", async () => {
    const dispose = vi.fn(async () => {});
    const apiKeys: ApiKeyManagementAPI = {
      create: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
      list: vi.fn(),
      revoke: vi.fn(),
    };
    vi.mocked(loadHotUpdater).mockResolvedValue(loadedConfig(apiKeys, dispose));

    await expect(handleApiKeyCreate("Production app")).rejects.toThrow(
      "database unavailable",
    );
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("rejects remote configs and still disposes them", async () => {
    const dispose = vi.fn(async () => {});
    vi.mocked(loadHotUpdater).mockResolvedValue(
      loadedConfig(undefined, dispose),
    );

    await expect(handleApiKeyList()).rejects.toThrow(
      "API key management requires a direct database config",
    );
    expect(dispose).toHaveBeenCalledOnce();
  });
});
