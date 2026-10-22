import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, string>());

vi.mock("./native", () => ({
  getStorageItem: (key: string) => store.get(key) ?? null,
  setStorageItem: (key: string, value: string | null) => {
    if (value === null) store.delete(key);
    else store.set(key, value);
  },
}));

const KEY = "hot-updater/recovery-check-config";
const saved = () => JSON.parse(store.get(KEY) ?? "null");

describe("recovery check config", () => {
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("__DEV__", false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves a check's request, with the default timeout when it sets none", async () => {
    const { saveRecoveryCheckConfig } = await import("./recoveryCheckConfig");
    saveRecoveryCheckConfig({
      baseURL: "https://updates.example.com",
      updateStrategy: "appVersion",
    });
    expect(saved()).toEqual({
      version: 1,
      baseURL: "https://updates.example.com",
      requestHeaders: {},
      requestTimeoutMs: 5000,
      updateStrategy: "appVersion",
    });
  });

  it("saves nothing at init before a check saved its update strategy", async () => {
    const { refreshRecoveryCheckConfig } =
      await import("./recoveryCheckConfig");
    refreshRecoveryCheckConfig({
      baseURL: "https://updates.example.com",
      requestHeaders: { "x-api-key": "key" },
    });
    expect(store.has(KEY)).toBe(false);
  });

  it("updates the saved request with what init configures", async () => {
    const { refreshRecoveryCheckConfig, saveRecoveryCheckConfig } =
      await import("./recoveryCheckConfig");
    saveRecoveryCheckConfig({
      baseURL: "https://old.example.com",
      requestHeaders: { "x-api-key": "old", "x-check": "kept" },
      requestTimeout: 3000,
      updateStrategy: "fingerprint",
    });
    refreshRecoveryCheckConfig({
      baseURL: "https://new.example.com/",
      requestHeaders: { "x-api-key": "new" },
      requestTimeout: 7000,
    });
    expect(saved()).toEqual({
      version: 1,
      baseURL: "https://new.example.com",
      requestHeaders: { "x-api-key": "new", "x-check": "kept" },
      requestTimeoutMs: 7000,
      updateStrategy: "fingerprint",
    });
  });

  it("keeps the saved server when init's baseURL is a function", async () => {
    const { refreshRecoveryCheckConfig, saveRecoveryCheckConfig } =
      await import("./recoveryCheckConfig");
    saveRecoveryCheckConfig({
      baseURL: "https://resolved.example.com",
      updateStrategy: "appVersion",
    });
    refreshRecoveryCheckConfig({ baseURL: () => "https://later.example.com" });
    expect(saved().baseURL).toBe("https://resolved.example.com");
    expect(saved().requestTimeoutMs).toBe(5000);
  });

  it("saves nothing at init in a development build", async () => {
    const { refreshRecoveryCheckConfig, saveRecoveryCheckConfig } =
      await import("./recoveryCheckConfig");
    saveRecoveryCheckConfig({
      baseURL: "https://release.example.com",
      updateStrategy: "appVersion",
    });
    vi.stubGlobal("__DEV__", true);
    refreshRecoveryCheckConfig({ baseURL: "https://dev.example.com" });
    expect(saved().baseURL).toBe("https://release.example.com");
  });

  it("ignores a saved value it can't read", async () => {
    const { refreshRecoveryCheckConfig } =
      await import("./recoveryCheckConfig");
    store.set(KEY, JSON.stringify({ version: 2, baseURL: "https://x" }));
    refreshRecoveryCheckConfig({ baseURL: "https://updates.example.com" });
    expect(saved()).toEqual({ version: 2, baseURL: "https://x" });
    store.set(KEY, "not json");
    refreshRecoveryCheckConfig({ baseURL: "https://updates.example.com" });
    expect(store.get(KEY)).toBe("not json");
  });
});
