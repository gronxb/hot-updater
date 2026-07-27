import { writeFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

import { STORAGE_V2_PROVIDER_MATRIX } from "../../packages/test-utils/src/storage/capabilityMatrix";
import { observeCloudflareWorker } from "./providerMatrixCloudflareWorker";
import { observeFirebaseMatrix } from "./providerMatrixFirebase";
import { observeMockMatrix } from "./providerMatrixMock";
import { observeS3Matrix } from "./providerMatrixS3";
import { observeStandaloneMatrix } from "./providerMatrixStandalone";
import { observeSupabaseMatrix } from "./providerMatrixSupabase";
import type { ProviderMatrixObservation } from "./providerMatrixTypes";

describe("Storage v2 provider-backed context matrix", () => {
  let observations: readonly ProviderMatrixObservation[] = [];

  beforeAll(async () => {
    observations = [
      ...(await observeMockMatrix()),
      ...(await observeS3Matrix()),
      await observeCloudflareWorker(),
      ...(await observeFirebaseMatrix()),
      ...(await observeSupabaseMatrix()),
      ...(await observeStandaloneMatrix()),
    ];
    const outputPath = process.env.STORAGE_MATRIX_OBSERVATIONS_PATH;
    if (outputPath !== undefined) {
      await writeFile(
        outputPath,
        `${JSON.stringify(observations, undefined, 2)}\n`,
      );
    }
  }, 60_000);

  it("executes one observation for every canonical public entry", () => {
    expect(observations.map(({ id, entry }) => ({ id, entry }))).toEqual(
      STORAGE_V2_PROVIDER_MATRIX.map(({ id, entry }) => ({ id, entry })),
    );
  });

  it("observes put, head, get, delete and A1-B-A2 provider state", () => {
    for (const observation of observations) {
      expect(observation.operations).toEqual(["put", "head", "get", "delete"]);
      expect(observation.contexts).toEqual(["A1", "B", "A2"]);
      expect(observation.origins).toEqual(["A", "B", "A"]);
      const visible = JSON.stringify(observation.providerVisible);
      expect(visible).toContain("A");
      expect(visible).toContain("B");
      expect(visible).toContain("A1");
      expect(visible).toContain("A2");
    }
  });

  it("matches target, cache, and stream lifetime guarantees", () => {
    for (const cell of STORAGE_V2_PROVIDER_MATRIX) {
      const observation = observations.find(({ id }) => id === cell.id);
      expect(observation).toBeDefined();
      expect(observation?.targets).toEqual(cell.acceptedTargets);
      expect(observation?.cache).toEqual({
        literal: cell.runtime.literalCache,
        tagged: cell.runtime.taggedCache,
      });
      expect(observation?.streamLifetime).toBe(cell.runtime.streamLifetime);
      expect(Object.keys(observation?.providerVisible ?? {})).not.toHaveLength(
        0,
      );
    }
  });

  it("keeps credential and header canaries out of errors and artifacts", () => {
    const serialized = JSON.stringify(observations);
    expect(serialized).not.toMatch(
      /matrix-key-|credential-[ab]|key-[ab]|token-[ab]|Bearer |Credential=/u,
    );
    expect(
      observations.every(({ secretCanaryLeaked }) => !secretCanaryLeaked),
    ).toBe(true);
  });
});
