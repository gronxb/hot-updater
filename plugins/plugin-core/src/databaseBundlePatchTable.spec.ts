import { describe, expect, it } from "vitest";

import {
  buildBundlePatchSetResource,
  buildBundlePatchRowResource,
  standardBundlePatchTable,
} from "./databaseBundlePatchTable";
import type { DatabaseBundlePatch } from "./types";

const patch = (
  bundleId: string,
  baseBundleId: string,
  orderIndex: number,
): DatabaseBundlePatch => ({
  bundleId,
  baseBundleId,
  baseFileHash: `base-${baseBundleId}`,
  patchFileHash: `patch-${bundleId}-${baseBundleId}`,
  patchStorageUri: `s3://bucket/${bundleId}-${baseBundleId}.patch`,
  orderIndex,
});

describe("standard bundle patch table", () => {
  it("maps the standard bundle patch row shape without plugin callbacks", () => {
    const currentPatch = patch("bundle-1", "base-1", 2);

    expect(standardBundlePatchTable.toRow(currentPatch)).toStrictEqual({
      id: "bundle-1:base-1",
      bundle_id: "bundle-1",
      base_bundle_id: "base-1",
      base_file_hash: "base-base-1",
      patch_file_hash: "patch-bundle-1-base-1",
      patch_storage_uri: "s3://bucket/bundle-1-base-1.patch",
      order_index: 2,
    });
    expect(
      standardBundlePatchTable.toPatch({
        id: "bundle-1:base-1",
        bundle_id: "bundle-1",
        base_bundle_id: "base-1",
        base_file_hash: "base-base-1",
        patch_file_hash: "patch-bundle-1-base-1",
        patch_storage_uri: "s3://bucket/bundle-1-base-1.patch",
        order_index: 2,
      }),
    ).toStrictEqual({ ...currentPatch, id: "bundle-1:base-1" });
  });

  it("maps only defined bundle patch update fields", () => {
    expect(
      standardBundlePatchTable.toUpdateRow({
        patchStorageUri: "s3://bucket/patch.zip",
        orderIndex: 3,
      }),
    ).toStrictEqual({
      patch_storage_uri: "s3://bucket/patch.zip",
      order_index: 3,
    });
    expect(standardBundlePatchTable.toUpdateRow({})).toStrictEqual({});
  });

  it("rejects standard rows and patches with mismatched ids", async () => {
    const invalidRow = {
      ...standardBundlePatchTable.toRow(patch("bundle-1", "base-1", 0)),
      id: "wrong-id",
    };
    const invalidPatch = {
      ...patch("bundle-1", "base-1", 0),
      id: "wrong-id",
    };
    const resource = buildBundlePatchRowResource({
      findRows: () => [invalidRow],
      getRowById: () => invalidRow,
      insertRow: () => {},
      updateRow: () => {},
      deleteRow: () => {},
    });

    expect(() => standardBundlePatchTable.toPatch(invalidRow)).toThrow(
      "Invalid bundle patch id",
    );
    expect(() => standardBundlePatchTable.toRow(invalidPatch)).toThrow(
      "Invalid bundle patch id",
    );
    expect(() =>
      standardBundlePatchTable.countPatches([invalidPatch], undefined),
    ).toThrow("Invalid bundle patch id");
    await expect(resource.getById({ patchId: "wrong-id" })).rejects.toThrow(
      "Invalid bundle patch id",
    );
    await expect(resource.count({})).rejects.toThrow("Invalid bundle patch id");
  });

  it("filters, sorts, and windows standard bundle patch rows", () => {
    const rows = [
      standardBundlePatchTable.toRow(patch("bundle-2", "base-2", 1)),
      standardBundlePatchTable.toRow(patch("bundle-1", "base-2", 0)),
      standardBundlePatchTable.toRow(patch("bundle-1", "base-1", 0)),
    ];

    expect(
      standardBundlePatchTable.list(rows, {
        where: { bundleId: "bundle-1" },
        window: { offset: 0, limit: 2 },
      }),
    ).toStrictEqual([
      { ...patch("bundle-1", "base-1", 0), id: "bundle-1:base-1" },
      { ...patch("bundle-1", "base-2", 0), id: "bundle-1:base-2" },
    ]);
    expect(
      standardBundlePatchTable.count(rows, {
        idIn: [],
      }),
    ).toBe(0);
  });

  it("filters, sorts, and windows in-memory bundle patches", () => {
    expect(
      standardBundlePatchTable.listPatches(
        [
          patch("bundle-2", "base-2", 1),
          patch("bundle-1", "base-2", 0),
          patch("bundle-1", "base-1", 0),
        ],
        {
          where: { bundleId: "bundle-1" },
          window: { offset: 1, limit: 1 },
        },
      ),
    ).toStrictEqual([
      { ...patch("bundle-1", "base-2", 0), id: "bundle-1:base-2" },
    ]);
  });

  it("creates a bundle patch resource from row store operations", async () => {
    let rows = [
      standardBundlePatchTable.toRow(patch("bundle-1", "base-1", 0)),
      standardBundlePatchTable.toRow(patch("bundle-1", "base-2", 1)),
    ];
    const updateRows: unknown[] = [];
    const resource = buildBundlePatchRowResource({
      findRows: () => rows,
      getRowById: ({ patchId }) =>
        rows.find((row) => row.id === patchId) ?? null,
      insertRow({ row }) {
        rows = rows.filter((current) => current.id !== row.id).concat(row);
      },
      updateRow({ patchId, row }) {
        updateRows.push(row);
        rows = rows.map((current) =>
          current.id === patchId ? { ...current, ...row } : current,
        );
      },
      deleteRow({ patchId }) {
        rows = rows.filter((row) => row.id !== patchId);
      },
    });

    await resource.insert({ patch: patch("bundle-2", "base-1", 2) });
    await resource.update({
      patchId: "bundle-2:base-1",
      patch: { patchStorageUri: "s3://bucket/updated.patch" },
    });
    await resource.delete({ patchId: "bundle-1:base-2" });

    await expect(
      resource.findMany({
        where: { bundleIdIn: ["bundle-1", "bundle-2"] },
        window: { offset: 0, limit: 10 },
      }),
    ).resolves.toStrictEqual([
      { ...patch("bundle-1", "base-1", 0), id: "bundle-1:base-1" },
      {
        ...patch("bundle-2", "base-1", 2),
        id: "bundle-2:base-1",
        patchStorageUri: "s3://bucket/updated.patch",
      },
    ]);
    await expect(resource.count({ where: { idIn: [] } })).resolves.toBe(0);
    await expect(
      resource.getById({ patchId: "bundle-2:base-1" }),
    ).resolves.toMatchObject({
      id: "bundle-2:base-1",
      patchStorageUri: "s3://bucket/updated.patch",
    });
    expect(updateRows).toStrictEqual([
      { patch_storage_uri: "s3://bucket/updated.patch" },
    ]);
  });

  it("creates a bundle patch resource from patch set operations", async () => {
    const patchesByBundle = new Map<string, readonly DatabaseBundlePatch[]>([
      ["bundle-1", [patch("bundle-1", "base-1", 0)]],
    ]);
    const resource = buildBundlePatchSetResource({
      findPatches: () => Array.from(patchesByBundle.values()).flat(),
      getBundlePatches: ({ bundleId }) => patchesByBundle.get(bundleId) ?? null,
      replaceBundlePatches({ bundleId, patches }) {
        patchesByBundle.set(bundleId, patches);
      },
    });

    await resource.insert({ patch: patch("bundle-1", "base-2", 2) });
    await resource.update({
      patchId: "bundle-1:base-2",
      patch: { orderIndex: 1 },
    });
    await resource.delete({ patchId: "bundle-1:base-1" });

    await expect(
      resource.findMany({
        where: { bundleId: "bundle-1" },
        window: { offset: 0, limit: 10 },
      }),
    ).resolves.toStrictEqual([
      {
        ...patch("bundle-1", "base-2", 2),
        id: "bundle-1:base-2",
        orderIndex: 1,
      },
    ]);
    await expect(
      resource.insert({ patch: patch("missing-bundle", "base-1", 0) }),
    ).rejects.toThrow("targetBundleId not found");
  });
});
