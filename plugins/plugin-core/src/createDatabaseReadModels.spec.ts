import { describe, expect, it, vi } from "vitest";

import { createDatabaseReadModels } from "./createDatabaseReadModels";
import type {
  BundlePatchRow,
  FindManyDatabaseImplementationInput,
} from "./types/internal";

describe("bundle patch owner pagination", () => {
  it("reads 420 selected patches once across owners without rescanning prefixes", async () => {
    const owners = ["owner-a", "owner-b", "owner-c"];
    const rows: BundlePatchRow[] = Array.from({ length: 630 }, (_, index) => ({
      id: `patch-${String(index).padStart(4, "0")}`,
      bundle_id: owners[index % owners.length]!,
      base_bundle_id: "base",
      base_file_hash: "base-hash",
      patch_file_hash: `hash-${index}`,
      patch_storage_uri: `storage://patch-${index}`,
      byte_size: index,
      order_index: 0,
    }));
    let rowsVisited = 0;
    let skippedPrefixRows = 0;
    const findMany = vi.fn(
      async (input: FindManyDatabaseImplementationInput) => {
        expect(input.model).toBe("bundle_patches");
        const ownerIds = input.where?.find(
          ({ field }) => field === "bundle_id",
        )?.value;
        const cursor = input.where?.find(({ field }) => field === "id")?.value;
        if (!Array.isArray(ownerIds))
          throw new Error("Expected one finite owner IN query");
        // Model an indexed range seek: OFFSET consumes matching prefix rows,
        // while an ID cursor starts directly after the previous page.
        const range = rows.filter(
          (row) =>
            ownerIds.includes(row.bundle_id) &&
            (typeof cursor !== "string" || row.id > cursor),
        );
        skippedPrefixRows += Math.min(input.offset, range.length);
        rowsVisited += Math.min(input.offset + input.limit, range.length);
        return range.slice(input.offset, input.offset + input.limit);
      },
    );
    const findOne = vi.fn();
    const count = vi.fn();
    const model = createDatabaseReadModels({
      findOne,
      findMany,
      count,
    }).bundlePatches;

    const result = await model.findByBundleIds([
      "owner-a",
      "owner-c",
      "owner-a",
    ]);
    const expected = rows.filter(({ bundle_id }) => bundle_id !== "owner-b");

    expect(result).toEqual(expected);
    expect(result).toHaveLength(420);
    expect(new Set(result.map(({ id }) => id)).size).toBe(420);
    expect({ rowsVisited, skippedPrefixRows }).toEqual({
      rowsVisited: 420,
      skippedPrefixRows: 0,
    });
    expect(findMany).toHaveBeenCalledTimes(5);
    findMany.mock.calls.forEach(([query], index) => {
      expect(query).toEqual({
        model: "bundle_patches",
        where: [
          { field: "bundle_id", operator: "in", value: ["owner-a", "owner-c"] },
          ...(index === 0
            ? []
            : [
                {
                  field: "id",
                  operator: "gt",
                  value: expected[index * 100 - 1]!.id,
                },
              ]),
        ],
        limit: 100,
        offset: 0,
        orderBy: [{ field: "id", direction: "asc" }],
      });
    });
    expect(findOne).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it("does no I/O for an empty owner set", async () => {
    const read = { findOne: vi.fn(), findMany: vi.fn(), count: vi.fn() };
    await expect(
      createDatabaseReadModels(read).bundlePatches.findByBundleIds([]),
    ).resolves.toEqual([]);
    expect(read.findOne).not.toHaveBeenCalled();
    expect(read.findMany).not.toHaveBeenCalled();
    expect(read.count).not.toHaveBeenCalled();
  });
});
