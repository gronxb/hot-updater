import type { Bundle } from "@hot-updater/core";
import { describe, expect, it } from "vitest";
import { mockDatabase } from "../mockDatabase";

const DEFAULT_BUNDLES_MOCK: Bundle[] = [
  {
    id: "0194ed78-ee7f-7d55-88f2-0511cbacc8f1",
    enabled: true,
    channel: "production",
    shouldForceUpdate: false,
    fileHash: "1234",
    gitCommitHash: "5678",
    platform: "ios",
    targetAppVersion: "1.0.x",
    message: null,
    storageUri:
      "storage://my-app/00000000-0000-0000-0000-000000000000/bundle.zip",
    fingerprintHash: null,
  },
  {
    id: "0194ed78-d791-753c-ba37-abb7259edcc8",
    enabled: true,
    channel: "production",
    shouldForceUpdate: false,
    fileHash: "1234",
    gitCommitHash: "5678",
    platform: "ios",
    targetAppVersion: "1.0.x",
    message: null,
    storageUri:
      "storage://my-app/00000000-0000-0000-0000-000000000000/bundle.zip",
    fingerprintHash: null,
  },
];

const DEFAULT_LATENCY = { min: 0, max: 0 };

describe("mockDatabase", () => {
  it("should return a database plugin", async () => {
    const plugin = mockDatabase({ latency: DEFAULT_LATENCY })({ cwd: "" });

    const bundles = await plugin.getBundles({ limit: 20, offset: 0 });

    expect(bundles.data).toEqual([]);
  });

  it("should return a database plugin with initial bundles", async () => {
    const plugin = mockDatabase({
      latency: DEFAULT_LATENCY,
      initialBundles: DEFAULT_BUNDLES_MOCK,
    })({ cwd: "" });

    const bundles = await plugin.getBundles({ limit: 20, offset: 0 });

    expect(bundles.data).toEqual(DEFAULT_BUNDLES_MOCK);
  });

  it("should append a bundle", async () => {
    const plugin = mockDatabase({ latency: DEFAULT_LATENCY })({ cwd: "" });

    await plugin.appendBundle(DEFAULT_BUNDLES_MOCK[0]);

    const bundles = await plugin.getBundles({ limit: 20, offset: 0 });

    expect(bundles.data).toEqual([DEFAULT_BUNDLES_MOCK[0]]);
  });

  it("should update a bundle", async () => {
    const plugin = mockDatabase({
      latency: DEFAULT_LATENCY,
      initialBundles: [DEFAULT_BUNDLES_MOCK[0]],
    })({ cwd: "" });

    await plugin.updateBundle(DEFAULT_BUNDLES_MOCK[0].id, {
      enabled: false,
    });

    const bundles = await plugin.getBundles({ limit: 20, offset: 0 });

    expect(bundles.data).toEqual([
      {
        ...DEFAULT_BUNDLES_MOCK[0],
        enabled: false,
      },
    ]);
  });

  it("should get bundle by id", async () => {
    const plugin = mockDatabase({
      latency: DEFAULT_LATENCY,
      initialBundles: DEFAULT_BUNDLES_MOCK,
    })({ cwd: "" });

    const bundle = await plugin.getBundleById(DEFAULT_BUNDLES_MOCK[0].id);

    expect(bundle).toEqual(DEFAULT_BUNDLES_MOCK[0]);
  });

  it("should throw error, if targetBundleId not found", async () => {
    const plugin = mockDatabase({
      latency: DEFAULT_LATENCY,
      initialBundles: [DEFAULT_BUNDLES_MOCK[0]],
    })({ cwd: "" });

    await expect(
      plugin.updateBundle("00000000-0000-0000-0000-000000000001", {
        enabled: false,
      }),
    ).rejects.toThrowError("targetBundleId not found");
  });

  it("should sort bundles by id", async () => {
    const plugin = mockDatabase({
      latency: DEFAULT_LATENCY,
      initialBundles: DEFAULT_BUNDLES_MOCK,
    })({ cwd: "" });

    const bundles = await plugin.getBundles({ limit: 20, offset: 0 });

    expect(bundles.data).toEqual(DEFAULT_BUNDLES_MOCK);
  });
});
