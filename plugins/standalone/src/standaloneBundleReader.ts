import type {
  CountDatabaseImplementationInput,
  DatabaseImplementationResult,
  FindManyDatabaseImplementationInput,
  FindOneDatabaseImplementationInput,
} from "@hot-updater/plugin-core/internal";

import { createBundleReads } from "./standaloneBundleReads";
import type { StandaloneBundleRemote } from "./standaloneBundleRemote";

type BundleModel = "bundle_patches" | "bundles";

export interface StandaloneBundleReader {
  count(
    input: Extract<CountDatabaseImplementationInput, { model: BundleModel }>,
  ): Promise<number>;
  findOne(
    input: Extract<FindOneDatabaseImplementationInput, { model: BundleModel }>,
  ): Promise<DatabaseImplementationResult | null>;
  findMany(
    input: Extract<FindManyDatabaseImplementationInput, { model: BundleModel }>,
  ): Promise<readonly DatabaseImplementationResult[]>;
}

export const createStandaloneBundleReader = (
  remote: StandaloneBundleRemote,
): StandaloneBundleReader => createBundleReads(remote);
