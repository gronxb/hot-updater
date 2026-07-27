import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

import {
  requestUnclaimedStorageCapability,
  STORAGE_V2_PROVIDER_MATRIX,
  STORAGE_V2_PROVIDER_MATRIX_DOCUMENT,
  STORAGE_V2_PROVIDER_MATRIX_FIXTURE,
  validateStorageProviderMatrix,
} from "./capabilityMatrix";
import { createMemoryStoragePlugin } from "./memoryStorage";

describe("Storage v2 canonical provider capability matrix", () => {
  beforeAll(async () => {
    const fixturePath = process.env.STORAGE_MATRIX_FIXTURE_PATH;
    const hashPath = process.env.STORAGE_MATRIX_HASH_PATH;
    if (fixturePath !== undefined) {
      await writeFile(fixturePath, STORAGE_V2_PROVIDER_MATRIX_FIXTURE);
    }
    if (hashPath !== undefined) {
      const hash = createHash("sha256")
        .update(STORAGE_V2_PROVIDER_MATRIX_FIXTURE)
        .digest("hex");
      await writeFile(hashPath, `${hash}\n`);
    }
  });

  it("drives the exact runtime and fixture cases from one typed value", () => {
    expect(STORAGE_V2_PROVIDER_MATRIX).toHaveLength(12);
    expect(new Set(STORAGE_V2_PROVIDER_MATRIX.map(({ id }) => id)).size).toBe(
      STORAGE_V2_PROVIDER_MATRIX.length,
    );
    expect(JSON.parse(STORAGE_V2_PROVIDER_MATRIX_FIXTURE)).toEqual(
      STORAGE_V2_PROVIDER_MATRIX_DOCUMENT,
    );
    expect(
      createHash("sha256")
        .update(STORAGE_V2_PROVIDER_MATRIX_FIXTURE)
        .digest("hex"),
    ).toMatch(/^[\da-f]{64}$/u);
  });

  it("byte-validates the runtime matrix fixture against canonical serialization", async () => {
    const runtimeFixture = await readFile(
      new URL("./release/fixtures/provider-matrix.json", import.meta.url),
      "utf8",
    );

    expect(runtimeFixture).toBe(STORAGE_V2_PROVIDER_MATRIX_FIXTURE);
    expect(JSON.parse(runtimeFixture)).toEqual(
      STORAGE_V2_PROVIDER_MATRIX_DOCUMENT,
    );
  });

  it("requires every ABI, guarantee, ownership, and runtime field", () => {
    for (const cell of STORAGE_V2_PROVIDER_MATRIX) {
      expect(cell.contractVersion).toBe(2);
      expect(cell.operations).toEqual({
        put: true,
        head: true,
        get: true,
        delete: true,
      });
      expect(cell.createOnly).toBe(true);
      expect(cell.range).toBe(true);
      expect(cell.delivery).toMatch(/^(supported|unsupported)$/u);
      expect(cell.list).toMatch(/^(supported|unsupported)$/u);
      expect(cell.ownership).toMatch(
        /^(borrowed-direct|owned-factory|remote-mount)$/u,
      );
      expect(cell.runtime.literalCache).toBe("allowed");
      expect(cell.runtime.taggedCache).toBe("forbidden");
      expect(cell.runtime.observations.length).toBeGreaterThan(0);
      expect(cell.acceptedTargets).toContain(cell.target);
    }
  });

  it("rejects flipped, wrong-target, missing, extra, and unsupported guarantees", () => {
    const canonical = structuredClone(STORAGE_V2_PROVIDER_MATRIX);
    const malformed: readonly unknown[] = [
      canonical.map((cell, index) =>
        index === 0 ? { ...cell, createOnly: false } : cell,
      ),
      canonical.map((cell, index) =>
        index === 1 ? { ...cell, acceptedTargets: ["worker"] } : cell,
      ),
      canonical.map((cell, index) => {
        if (index !== 2) return cell;
        const { range: _range, ...missing } = cell;
        return missing;
      }),
      canonical.map((cell, index) =>
        index === 3 ? { ...cell, inventedGuarantee: true } : cell,
      ),
      canonical.map((cell, index) =>
        index === 4
          ? {
              ...cell,
              runtime: { ...cell.runtime, taggedCache: "allowed" },
            }
          : cell,
      ),
    ];

    for (const cells of malformed) {
      expect(() => validateStorageProviderMatrix(cells)).toThrowError(
        /canonical data/u,
      );
    }
  });

  it("contains no credential, endpoint, header, or secret canary value", () => {
    expect(STORAGE_V2_PROVIDER_MATRIX_FIXTURE).not.toMatch(
      /seeded-secret|authorization:|credential=|https?:\/\//iu,
    );
  });

  it.each(["issueDownload", "list"] as const)(
    "normalizes an unclaimed %s request to exact unsupported",
    (capability) => {
      const plugin = createMemoryStoragePlugin();
      expect(() =>
        requestUnclaimedStorageCapability(plugin, capability),
      ).toThrowError(
        expect.objectContaining({
          name: "StoragePluginError",
          code: "unsupported",
        }),
      );
    },
  );
});
