import type { Release } from "@hot-updater/protocol";
import {
  createBundleFixture,
  setReleaseCatalogPartitioning,
} from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import type { ServerCoreApi } from "./api";
import {
  appVersionScope,
  createScopeOracle,
  createWriteTestAdapter,
  createWriteTestCore,
  fullCatalogOf,
  releasePolicy,
  releasesIn,
  storedScope,
} from "./catalogWrites.testFixtures";

const createRandom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const EXACT = ["1.0.0", "1.0.1", "1.2.0", "2.0.0", "2.1.0", "3.0.0"];
const RANGES = ["*", ">=1.0.0 <2.0.0", "1.x", "~1.2.0", ">=2.0.0", "<1.2.0"];

/** One write of a generated sequence, applied through core's public writes. */
const applyStep = async (
  core: ServerCoreApi,
  random: () => number,
  step: number,
) => {
  const production = await releasesIn(core, appVersionScope("production"));
  const pick = <T>(items: readonly T[]) =>
    items[Math.floor(random() * items.length)]!;
  const roll = random();
  if (production.length < 3 || roll < 0.45) {
    const range = random() < 0.6 ? pick(EXACT) : pick(RANGES);
    await core.deploy([
      {
        bundle: createBundleFixture(String(1000 + step)),
        release: releasePolicy("production", range, {
          enabled: random() > 0.1,
          ...(random() < 0.2
            ? { rolloutCohortCount: Math.floor(random() * 1000) }
            : {}),
          ...(random() < 0.15 ? { targetCohorts: ["qa"] } : {}),
          ...(random() < 0.2 ? { message: `m${step}` } : {}),
        }),
      },
    ]);
    return "deploy";
  }
  const target = pick(production);
  if (roll < 0.65) {
    await core.updateReleasePolicy({
      releaseId: target.id,
      patch:
        random() < 0.5
          ? { enabled: !target.enabled }
          : random() < 0.5
            ? { rolloutCohortCount: Math.floor(random() * 1001) }
            : { targetAppVersion: pick([...EXACT, ...RANGES]) },
    });
    return "update";
  }
  if (roll < 0.75) {
    const disabled = production.filter((release) => !release.enabled);
    if (disabled.length === 0) return "skip";
    await core.deleteRelease({ releaseId: pick(disabled).id });
    return "delete";
  }
  if (roll < 0.88) {
    if (target.bundleId === null) return "skip";
    await core.promoteRelease({
      action: random() < 0.5 ? "copy" : "move",
      releaseId: target.id,
      targetChannel: "beta",
    });
    return "promote";
  }
  await core.rebuildReleaseCatalog(appVersionScope("production"));
  return "rebuild";
};

const runSequence = async ({
  maxOps,
  seed,
  snapshots = false,
  steps,
  switchAt,
}: {
  readonly maxOps: number;
  readonly seed: number;
  readonly snapshots?: boolean;
  readonly steps: number;
  readonly switchAt: number;
}) => {
  const io = createWriteTestAdapter({ maxOps, snapshots });
  const core = createWriteTestCore(io.adapter);
  const random = createRandom(seed);
  const oracles = [createScopeOracle("production"), createScopeOracle("beta")];
  const histories = new Map<string, Map<string, Release>>();
  const generations = new Map<string, number>();
  const hashes = new Map<string, string>();
  const catalogIds = new Map<string, string>();
  const mismatches: string[] = [];
  const kinds = new Map<string, number>();
  let partitionedSteps = 0;
  let stagedSteps = 0;
  for (let step = 0; step < steps; step += 1) {
    if (step === switchAt) await setReleaseCatalogPartitioning(io.memory, "on");
    const epochs = new Map<string, string | null>();
    for (const oracle of oracles) {
      epochs.set(
        oracle.scopeKey,
        (await storedScope(io.memory, oracle.scopeKey)).liveEpoch,
      );
    }
    const kind = await applyStep(core, random, step);
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    for (const oracle of oracles) {
      const scopeHistory = histories.get(oracle.scopeKey) ?? new Map();
      histories.set(oracle.scopeKey, scopeHistory);
      for (const release of await releasesIn(core, oracle.scopeKey)) {
        scopeHistory.set(release.id, release);
      }
      const found = await oracle.step(core, [...scopeHistory.values()]);
      mismatches.push(...found.map((text) => `step ${step} ${kind}: ${text}`));
      const stored = await storedScope(io.memory, oracle.scopeKey);
      mismatches.push(
        ...stored.problems.map((text) => `step ${step} ${kind}: ${text}`),
      );
      if (stored.row === null) continue;
      // Generations only grow, and one catalog ID holds through every layout.
      const previous = generations.get(oracle.scopeKey) ?? 0;
      if (stored.row.generation < previous) {
        mismatches.push(`step ${step}: generation went back`);
      }
      generations.set(oracle.scopeKey, stored.row.generation);
      // One generation, one hash: a write that changes the row advances it.
      const key = `${oracle.scopeKey}@${stored.row.generation}`;
      const hash = hashes.get(key) ?? stored.row.catalog_hash;
      if (hash !== stored.row.catalog_hash) {
        mismatches.push(
          `step ${step}: generation ${stored.row.generation} has two hashes`,
        );
      }
      hashes.set(key, hash);
      const id = catalogIds.get(oracle.scopeKey) ?? stored.row.catalog_id;
      if (id !== stored.row.catalog_id)
        mismatches.push(`step ${step}: catalog_id`);
      catalogIds.set(oracle.scopeKey, id);
      if (stored.liveEpoch !== null) {
        partitionedSteps += 1;
        // The live rows are exactly what a full compile of the scope stores.
        const { tiling } = await fullCatalogOf(
          await releasesIn(core, oracle.scopeKey),
        );
        if (
          JSON.stringify(
            stored.live.map((row) => [row.lowerKey, row.partitionHash]),
          ) !==
          JSON.stringify(
            tiling?.map((row) => [row.lowerKey, row.partitionHash]),
          )
        ) {
          mismatches.push(
            `step ${step} ${kind}: live rows differ from a full compile`,
          );
        }
        const before = epochs.get(oracle.scopeKey);
        if (
          before !== null &&
          before !== undefined &&
          before !== stored.liveEpoch
        ) {
          stagedSteps += 1;
        }
      }
      // Garbage stays bounded by one retired tiling: each staged publication
      // drains before it stages, and every write runs one cleanup step.
      const retired = [...stored.epochs].filter(
        (epoch) => epoch !== stored.liveEpoch,
      );
      if (retired.length > 1) {
        mismatches.push(
          `step ${step} ${kind}: ${retired.length} retired epochs`,
        );
      }
      if (step < switchAt && stored.total > 0) {
        mismatches.push(`step ${step}: a partition row with the switch off`);
      }
    }
  }
  return {
    counts: oracles.map((oracle) => oracle.counts()),
    kinds,
    mismatches,
    partitionedSteps,
    stagedSteps,
  };
};

describe("partitioned release catalog writes: the differential oracle", () => {
  it.each([
    { name: "atomic", maxOps: Number.POSITIVE_INFINITY, seed: 1 },
    { name: "atomic", maxOps: Number.POSITIVE_INFINITY, seed: 2 },
    { name: "staged", maxOps: 9, seed: 3 },
    { name: "staged", maxOps: 9, seed: 4 },
    {
      name: "atomic, snapshot reads",
      maxOps: Number.POSITIVE_INFINITY,
      seed: 5,
      snapshots: true,
    },
    { name: "staged, snapshot reads", maxOps: 9, seed: 6, snapshots: true },
  ])(
    "every device decides as from the full compact catalog, $name writes (seed $seed)",
    async ({ maxOps, seed }) => {
      const result = await runSequence({
        maxOps,
        seed,
        steps: 45,
        switchAt: 6,
      });
      expect(result.mismatches).toEqual([]);
      // The sequence reached what it claims to cover.
      expect(result.partitionedSteps).toBeGreaterThan(30);
      for (const kind of ["deploy", "update", "promote"]) {
        expect(result.kinds.get(kind) ?? 0).toBeGreaterThan(0);
      }
      if (maxOps !== Number.POSITIVE_INFINITY) {
        expect(result.stagedSteps).toBeGreaterThan(5);
      } else {
        expect(result.stagedSteps).toBe(0);
      }
      expect(result.counts[0]!.decisions).toBeGreaterThan(1000);
    },
    120_000,
  );
});
