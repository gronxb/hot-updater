import { describe, expect, it } from "vitest";

import packageJson from "../../package.json" with { type: "json" };

describe("Cloudflare R2 Storage v2 package exports", () => {
  it("selects exactly one target-specific conditional entry", () => {
    // Given
    const storageExport = packageJson.exports["./storage"];

    // When
    const conditions = Object.keys(storageExport);

    // Then
    expect(conditions).toEqual(["workerd", "worker", "node", "default"]);
    expect(storageExport.workerd).toEqual(storageExport.worker);
    expect(storageExport.workerd.default).toBe("./dist/storage/worker.mjs");
    expect(storageExport.node.import.default).toBe("./dist/storage/node.mjs");
    expect(storageExport.node.require.default).toBe("./dist/storage/node.cjs");
    expect(storageExport.default.import.default).toBe(
      "./dist/storage/unsupported.mjs",
    );
  });

  it("preserves legacy root and Worker exports", () => {
    // Given
    const rootExport = packageJson.exports["."];
    const workerExport = packageJson.exports["./worker"];

    // When
    const publicLegacyEntries = { rootExport, workerExport };

    // Then
    expect(publicLegacyEntries).toEqual({
      rootExport: {
        import: "./dist/index.mjs",
        require: "./dist/index.cjs",
      },
      workerExport: {
        import: {
          types: "./dist/worker/index.d.mts",
          default: "./dist/worker/index.mjs",
        },
      },
    });
  });

  it("publishes explicit Node and Worker Storage v2 entries", () => {
    // Given
    const nodeExport = packageJson.exports["./storage/node"];
    const workerExport = packageJson.exports["./storage/worker"];

    // When
    const entries = { nodeExport, workerExport };

    // Then
    expect(entries).toEqual({
      nodeExport: {
        import: {
          types: "./dist/storage/node.d.mts",
          default: "./dist/storage/node.mjs",
        },
        require: {
          types: "./dist/storage/node.d.cts",
          default: "./dist/storage/node.cjs",
        },
      },
      workerExport: {
        types: "./dist/storage/worker.d.mts",
        import: "./dist/storage/worker.mjs",
      },
    });
  });
});
