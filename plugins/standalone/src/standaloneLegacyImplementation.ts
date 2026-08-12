import type {
  CountDatabaseImplementationInput,
  CreateDatabaseImplementationInput,
  DatabaseImplementationResult,
  DeleteDatabaseImplementationInput,
  FindManyDatabaseImplementationInput,
  FindOneDatabaseImplementationInput,
  UpdateDatabaseImplementationInput,
} from "@hot-updater/plugin-core/internal";

import type { StandaloneBundleRemote } from "./standaloneBundleRemote";
import { createLegacyReads } from "./standaloneLegacyReads";
import { createLegacyWrites } from "./standaloneLegacyWrites";

type BundleModel = "bundle_patches" | "bundles";

export interface StandaloneLegacyImplementation {
  create(
    input: Extract<CreateDatabaseImplementationInput, { model: BundleModel }>,
  ): Promise<DatabaseImplementationResult>;
  update(
    input: Extract<UpdateDatabaseImplementationInput, { model: "bundles" }>,
  ): Promise<DatabaseImplementationResult | null>;
  delete(
    input: Extract<DeleteDatabaseImplementationInput, { model: BundleModel }>,
  ): Promise<void>;
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

export const createLegacyCompatibilityImplementation = (
  remote: StandaloneBundleRemote,
): StandaloneLegacyImplementation => {
  return {
    ...createLegacyWrites(remote),
    ...createLegacyReads(remote),
  };
};
