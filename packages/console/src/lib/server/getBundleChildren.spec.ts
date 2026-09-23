// @vitest-environment node

import type { Bundle, HotUpdaterCoreApi } from "@hot-updater/plugin-core";
import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";
import { createDatabaseCoreApi } from "@hot-updater/server/db";
import { describe, expect, it, vi } from "vitest";

import { getBundleChildCounts, getBundleChildren } from "./getBundleChildren";

const id = (sequence: number) =>
  `01900000-0000-7000-8000-${String(sequence).padStart(12, "0")}`;

const bundle = (bundleId: string, patches: Bundle["patches"] = []): Bundle => ({
  id: bundleId,
  platform: "ios",
  gitCommitHash: null,
  manifestStorageUri: `s3://bucket/${bundleId}/manifest.json`,
  manifestFileHash: `manifest-${bundleId}`,
  assetBaseStorageUri: "s3://bucket/assets",
  patches,
});

const patchFrom = (base: Bundle) => ({
  baseBundleId: base.id,
  baseFileHash: base.manifestFileHash,
  byteSize: 10,
  patchFileHash: `patch-${base.id}`,
  patchStorageUri: `s3://bucket/patches/${base.id}`,
});

const deploy = (core: HotUpdaterCoreApi, deployed: Bundle) =>
  core.deploy([
    {
      bundle: deployed,
      release: {
        channel: "production",
        enabled: true,
        fingerprintHash: null,
        message: null,
        shouldForceUpdate: false,
        targetAppVersion: "1.0.x",
      },
    },
  ]);

describe("bundle children", () => {
  it("lists the bundles patched from a base, newest first", async () => {
    const core = createDatabaseCoreApi(createMemoryAdapter());
    const base = bundle(id(1));
    const other = bundle(id(2));
    const first = bundle(id(3), [patchFrom(base)]);
    const second = bundle(id(4), [patchFrom(base), patchFrom(other)]);
    for (const deployed of [base, other, first, second]) {
      await deploy(core, deployed);
    }

    const children = await getBundleChildren(core, base.id);

    expect(children.map(({ id: childId }) => childId)).toEqual([
      second.id,
      first.id,
    ]);
    expect(children[0]?.patches).toHaveLength(2);
    await expect(getBundleChildren(core, first.id)).resolves.toEqual([]);
  });

  it("counts children from each base bundle's counter", async () => {
    const core = createDatabaseCoreApi(createMemoryAdapter());
    const base = bundle(id(1));
    const other = bundle(id(2));
    for (const deployed of [
      base,
      other,
      bundle(id(3), [patchFrom(base)]),
      bundle(id(4), [patchFrom(base), patchFrom(other)]),
    ]) {
      await deploy(core, deployed);
    }

    await expect(
      getBundleChildCounts(core, [base.id, other.id, id(4), "missing"]),
    ).resolves.toEqual({
      [base.id]: 2,
      [other.id]: 1,
      [id(4)]: 0,
      missing: 0,
    });
  });

  it("reads each base bundle once, with no bundle scan", async () => {
    const getBundle = vi.fn(async () => null);

    await getBundleChildCounts({ getBundle }, [id(1), id(1), "", id(2)]);

    expect(getBundle.mock.calls).toEqual([[id(1)], [id(2)]]);
  });
});
