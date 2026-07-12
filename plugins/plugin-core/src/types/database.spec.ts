import { describe, expectTypeOf, it } from "vitest";

import type {
  BundleRow,
  CountBundlesDatabaseInput,
  DatabasePlugin,
  DeleteDatabaseInput,
  FindManyDatabaseInput,
  FindOneDatabaseInput,
  TransactionDatabasePlugin,
  UpdateBundleDatabaseInput,
} from "./database";

describe("database plugin types", () => {
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
    const exerciseProjection = async (adapter: DatabasePlugin) => {
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

  it("keeps transaction operations input-only", () => {
    // Given / When / Then
    expectTypeOf<TransactionDatabasePlugin["count"]>().parameters.toEqualTypeOf<
      [CountBundlesDatabaseInput]
    >();
  });
});
