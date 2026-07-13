import { describe, expectTypeOf, it } from "vitest";

import type {
  BundleRow,
  CountBundlesDatabaseInput,
  DatabaseAdapter,
  DeleteDatabaseInput,
  FindManyDatabaseInput,
  FindOneDatabaseInput,
  TransactionDatabaseAdapter,
  UpdateBundleDatabaseInput,
} from "./database";

describe("database adapter types", () => {
  it("keeps unsupported model and operation pairs outside the contract", () => {
    // Given
    type ChannelCount = { readonly model: "channels" };
    type PatchUpdate = { readonly model: "bundle_patches" };
    type PatchFindOne = { readonly model: "bundle_patches" };
    type ChannelDelete = { readonly model: "channels" };

    // When / Then
    expectTypeOf<ChannelCount>().not.toMatchTypeOf<CountBundlesDatabaseInput>();
    expectTypeOf<PatchUpdate>().not.toMatchTypeOf<UpdateBundleDatabaseInput>();
    expectTypeOf<PatchFindOne>().not.toMatchTypeOf<
      FindOneDatabaseInput<"bundles" | "channels">
    >();
    expectTypeOf<ChannelDelete>().not.toMatchTypeOf<
      DeleteDatabaseInput<"bundle_patches" | "bundles">
    >();
  });

  it("correlates physical fields and projected results with the model", () => {
    // Given
    const exerciseProjection = async (adapter: DatabaseAdapter) => {
      // When
      const row = await adapter.findOne({
        model: "bundles",
        select: ["id", "file_hash"],
      });

      // Then
      expectTypeOf(row).toEqualTypeOf<Pick<
        BundleRow,
        "file_hash" | "id"
      > | null>();
    };

    expectTypeOf(exerciseProjection).toBeFunction();
    expectTypeOf<FindManyDatabaseInput<"bundle_patches">>().not.toMatchTypeOf<{
      readonly model: "bundle_patches";
      readonly sortBy: {
        readonly field: "file_hash";
        readonly direction: "asc";
      };
    }>();
  });

  it("keeps structured fields outside portable predicates and sorting", () => {
    type MetadataWhere = {
      readonly model: "bundles";
      readonly where: readonly [
        {
          readonly field: "metadata";
          readonly value: { readonly release: "stable" };
        },
      ];
    };
    type CohortWhere = {
      readonly model: "bundles";
      readonly where: readonly [
        {
          readonly field: "target_cohorts";
          readonly value: readonly ["qa"];
        },
      ];
    };
    type MetadataSort = {
      readonly model: "bundles";
      readonly sortBy: {
        readonly field: "metadata";
        readonly direction: "asc";
      };
    };

    expectTypeOf<MetadataWhere>().not.toMatchTypeOf<
      FindManyDatabaseInput<"bundles">
    >();
    expectTypeOf<CohortWhere>().not.toMatchTypeOf<
      FindManyDatabaseInput<"bundles">
    >();
    expectTypeOf<MetadataSort>().not.toMatchTypeOf<
      FindManyDatabaseInput<"bundles">
    >();
  });

  it("keeps transaction operations input-only", () => {
    // Given / When / Then
    expectTypeOf<
      TransactionDatabaseAdapter["count"]
    >().parameters.toEqualTypeOf<[CountBundlesDatabaseInput]>();
  });
});
