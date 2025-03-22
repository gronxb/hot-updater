import type { Bundle } from "@hot-updater/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pocketbaseDatabase } from "../pocketbaseDatabase";
import type { PocketbaseBundle } from "../types";

const BUNDLE_BASE_DATA = {
  targetAppVersion: "*",
  shouldForceUpdate: false,
  enabled: true,
  fileUrl: "http://example.com/bundle_1.zip",
  fileHash: "hash",
  platform: "ios",
  gitCommitHash: null,
  message: null,
} as const

const POCKETBASE_BUNDLES: PocketbaseBundle[] = [
  {
    id: "somePocketbaseID1",
    bundleId: "00000000-0000-0000-0000-000000000001",
    ...BUNDLE_BASE_DATA
  },
  {
    id: "somePocketbaseID2",
    bundleId: "00000000-0000-0000-0000-000000000002",
    ...BUNDLE_BASE_DATA
  },
];

const BUNDLES: Bundle[] = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    ...BUNDLE_BASE_DATA
  },
  {
    
    id: "00000000-0000-0000-0000-000000000002",
    ...BUNDLE_BASE_DATA
  },
]

let update = vi.fn(() => Promise.resolve());
let getFullList = vi.fn(() => Promise.resolve(POCKETBASE_BUNDLES));
let getFirstListItem = vi.fn((filter?: string) => Promise.resolve(POCKETBASE_BUNDLES[0]));

const Pocketbase = vi.fn();
Pocketbase.prototype.collection = vi.fn(() => {
  return {
    update,
    getFullList,
    getFirstListItem
  };
});

describe("pocketbaseDatabase", () => {

  beforeEach(()=>{
    update = vi.fn(() => Promise.resolve());
    getFullList = vi.fn(() => Promise.resolve(POCKETBASE_BUNDLES));
    getFirstListItem = vi.fn(() => Promise.resolve(POCKETBASE_BUNDLES[0]));
  })

  it("should get bundles", async () => {
    const pocketbaseClient = new Pocketbase();
    const plugin = pocketbaseDatabase({
      host: "someHost",
      bundlesCollection: "bundles",
    })({ cwd: "", pocketbaseClient });

    const bundles = await plugin.getBundles();

    expect(pocketbaseClient.collection).toHaveBeenCalledWith("bundles");
    expect(getFullList).toHaveBeenCalledTimes(1);
    expect(bundles.length).toEqual(2);
  });

  it("should append a bundle", async () => {
    const pocketbaseClient = new Pocketbase();
    const plugin = pocketbaseDatabase({
      host: "someHost",
      bundlesCollection: "bundles",
    })({ cwd: "", pocketbaseClient });

    await plugin.appendBundle(BUNDLES[0]);

    expect(pocketbaseClient.collection).toHaveBeenCalledWith("bundles");

    expect(getFirstListItem).toHaveBeenCalledTimes(1);
    expect(getFirstListItem).toHaveBeenCalledWith(`bundleId="${POCKETBASE_BUNDLES[0].bundleId}"`);

    expect(update).toHaveBeenCalledTimes(1);

    const {id, ...bundleData} = POCKETBASE_BUNDLES[0];

    expect(update).toHaveBeenCalledWith(id, bundleData);
  });

  it("should update a bundle", async () => {
    const pocketbaseClient = new Pocketbase();
    const plugin = pocketbaseDatabase({
      host: "someHost",
      bundlesCollection: "bundles",
    })({ cwd: "", pocketbaseClient });

    await plugin.updateBundle(POCKETBASE_BUNDLES[0].bundleId, {
      enabled: false,
    });

    expect(pocketbaseClient.collection).toHaveBeenCalledWith("bundles");

    expect(getFirstListItem).toHaveBeenCalledTimes(1);
    expect(getFirstListItem).toHaveBeenCalledWith(`bundleId="${POCKETBASE_BUNDLES[0].bundleId}"`);

    expect(update).toHaveBeenCalledTimes(1);

    const {id} = POCKETBASE_BUNDLES[0];

    expect(update).toHaveBeenCalledWith(id, {enabled: false});
  });

  it("should get bundle by id", async () => {
    const pocketbaseClient = new Pocketbase();
    const plugin = pocketbaseDatabase({
      host: "someHost",
      bundlesCollection: "bundles",
    })({ cwd: "", pocketbaseClient });

    const bundle = await plugin.getBundleById(POCKETBASE_BUNDLES[0].bundleId);
    expect(getFirstListItem).toHaveBeenCalledTimes(1);
    expect(getFirstListItem).toHaveBeenCalledWith(`bundleId="${POCKETBASE_BUNDLES[0].bundleId}"`);

    expect(bundle).toEqual(BUNDLES[0]);
  });

  it("should throw error, if target bundle version not found", async () => {
    getFirstListItem = vi.fn((filter) => Promise.reject(new Error(`Could not find item ${filter}`)));

    const pocketbaseClient = new Pocketbase();
    const plugin = pocketbaseDatabase({
      host: "someHost",
      bundlesCollection: "bundles",
    })({ cwd: "", pocketbaseClient });


    const invalidBundleId = "00000000-0000-0000-0000-000000000003"

    await expect(
      plugin.updateBundle(invalidBundleId, {
        enabled: false,
      }),
    ).rejects.toThrowError(`Could not find item bundleId="${invalidBundleId}"`);

    expect(getFirstListItem).toHaveBeenCalledTimes(1);
    expect(getFirstListItem).toHaveBeenCalledWith(`bundleId="${invalidBundleId}"`);
  });

  it("should sort bundles by id", async () => {
    getFullList = vi.fn(() => Promise.resolve(POCKETBASE_BUNDLES.reverse()));

    const pocketbaseClient = new Pocketbase();
    const plugin = pocketbaseDatabase({
      host: "someHost",
      bundlesCollection: "bundles",
    })({ cwd: "", pocketbaseClient });

    const bundles = await plugin.getBundles();

    expect(getFullList).toHaveBeenCalledTimes(1);
    expect(bundles).toEqual(BUNDLES);
  });
});
