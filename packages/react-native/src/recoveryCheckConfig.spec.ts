import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, string>());

vi.mock("./native", () => ({
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

  it("replaces the previous check's request, headers included", async () => {
    const { saveRecoveryCheckConfig } = await import("./recoveryCheckConfig");
    saveRecoveryCheckConfig({
      baseURL: "https://a.example.com",
      requestHeaders: { Authorization: "Bearer a" },
      requestTimeout: 3000,
      updateStrategy: "fingerprint",
    });
    saveRecoveryCheckConfig({
      baseURL: "https://b.example.com",
      requestHeaders: { "x-api-key": "b" },
      updateStrategy: "appVersion",
    });
    expect(saved()).toEqual({
      version: 1,
      baseURL: "https://b.example.com",
      requestHeaders: { "x-api-key": "b" },
      requestTimeoutMs: 5000,
      updateStrategy: "appVersion",
    });
  });
});
