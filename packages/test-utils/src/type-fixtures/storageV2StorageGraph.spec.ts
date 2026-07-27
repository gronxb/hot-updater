import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  runtimeGraphMatrix,
  storageGraphMatrix,
  type StorageGraphCell,
} from "./storageGraphMatrix.fixture";
import {
  createPackedStorageGraph,
  type PackedStorageGraph,
  storageGraphCanaries,
} from "./storageGraphPacked";
import {
  assertStorageGraphPolicy,
  type StorageGraphManifest,
} from "./storageGraphPolicy";
import { createSourceGraphManifest } from "./storageGraphSource";

const workspaceRoot = path.resolve(import.meta.dirname, "../../../..");
const graphCells = [...storageGraphMatrix, ...runtimeGraphMatrix];
const receipts: Readonly<{
  artifact: StorageGraphManifest;
  id: string;
  source: StorageGraphManifest;
}>[] = [];
let packedGraph: PackedStorageGraph;
let deliberateFailure = "";
let canaryLeaks: readonly string[] = [];

beforeAll(async () => {
  packedGraph = await createPackedStorageGraph(workspaceRoot);
}, 120_000);

afterAll(async () => {
  await packedGraph.dispose();
  const output = process.env.STORAGE_GRAPH_MANIFEST_OUTPUT;
  if (output !== undefined) {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(
      output,
      `${JSON.stringify(
        {
          canaries: storageGraphCanaries,
          canaryLeaks,
          cells: receipts,
          command:
            "pnpm exec vitest run packages/test-utils/src/runtimePackageConsumers.spec.ts packages/test-utils/src/type-fixtures/*Storage*Graph*.spec.ts",
          deliberateFailure,
        },
        null,
        2,
      )}\n`,
    );
  }
});

describe("Storage v2 import graph policy", () => {
  it("names every forbidden importing edge and the Worker target", async () => {
    // Given
    const importer = path.join(
      import.meta.dirname,
      "fixtures/storageGraphWorkerForbidden.fixture.txt",
    );
    const manifest = await createSourceGraphManifest(importer, workspaceRoot);

    // When
    try {
      assertStorageGraphPolicy(manifest, {
        allowedExternalPrefixes: [
          "@hot-updater/core",
          "@hot-updater/js",
          "@hot-updater/plugin-core",
        ],
        deniedExternalPrefixes: ["@hot-updater/cli-tools", "node:"],
        target: "worker",
      });
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      deliberateFailure = error.message;
    }

    // Then
    expect(deliberateFailure).toMatch(
      /(?=.*storageGraphWorkerForbidden\.fixture\.txt)(?=.*@hot-updater\/cli-tools)(?=.*node:fs)(?=.*worker)/su,
    );
  });

  it.each(graphCells)(
    "matches the committed source and packed artifact policy for $id",
    async (cell: StorageGraphCell) => {
      // Given
      const source = await createSourceGraphManifest(
        path.join(workspaceRoot, cell.sourceEntry),
        workspaceRoot,
      );

      // When
      const artifact = await packedGraph.createManifest(cell);

      // Then
      assertStorageGraphPolicy(source, cell.policy);
      assertStorageGraphPolicy(artifact, cell.policy);
      expect(
        artifact.edges.filter(({ resolvedTarget }) => resolvedTarget === null),
      ).toEqual([]);
      receipts.push({ artifact, id: cell.id, source });
    },
    30_000,
  );

  it("does not emit seeded secret canaries into packed artifacts", async () => {
    // Given
    expect(storageGraphCanaries).toHaveLength(3);

    // When
    canaryLeaks = await packedGraph.findCanaryLeaks();

    // Then
    expect(canaryLeaks).toEqual([]);
  });
});
