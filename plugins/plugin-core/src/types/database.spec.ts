import { describe, expectTypeOf, it } from "vitest";

import type {
  BundlePatchRow,
  BundleRow,
  CountDatabaseImplementationInput,
  CreateDatabaseImplementationInput,
  DatabasePlugin,
  DatabaseBundleMetadata,
  DatabaseModel,
  FindManyDatabaseInput,
  FindManyDatabasePluginInput,
  FindOneDatabaseInput,
  TransactionDatabasePlugin,
} from "./database";

describe("database plugin types", () => {
  it("keeps unsupported model and operation pairs outside the contract", () => {
    expectTypeOf<"channels">().not.toMatchTypeOf<DatabaseModel>();
  });

  it("correlates physical fields and projected results with the model", () => {
    const exerciseProjection = async (plugin: DatabasePlugin) => {
      const row = await plugin.findOne({
        model: "bundles",
        select: ["id", "file_hash"],
      });

      expectTypeOf(row).toEqualTypeOf<Pick<
        BundleRow,
        "file_hash" | "id"
      > | null>();
    };

    expectTypeOf(exerciseProjection).toBeFunction();
    expectTypeOf<FindManyDatabaseInput<"bundle_patches">>().not.toMatchTypeOf<{
      readonly model: "bundle_patches";
      readonly orderBy: readonly [
        { readonly field: "metadata"; readonly direction: "asc" },
      ];
    }>();
  });

  it("rejects cross-model implementation rows and queries", () => {
    expectTypeOf<{
      readonly model: "bundles";
      readonly data: BundlePatchRow;
    }>().not.toMatchTypeOf<CreateDatabaseImplementationInput>();
    expectTypeOf<{
      readonly model: "bundle_patches";
      readonly where: readonly [
        { readonly field: "metadata"; readonly value: "release" },
      ];
    }>().not.toMatchTypeOf<FindManyDatabasePluginInput>();
  });

  it("keeps structured fields outside portable predicates and ordering", () => {
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

    expectTypeOf<MetadataWhere>().not.toMatchTypeOf<
      FindManyDatabaseInput<"bundles">
    >();
    expectTypeOf<CohortWhere>().not.toMatchTypeOf<
      FindManyDatabaseInput<"bundles">
    >();
  });

  it("restricts bundle metadata to JSON objects", () => {
    expectTypeOf<
      BundleRow["metadata"]
    >().toEqualTypeOf<DatabaseBundleMetadata>();
    expectTypeOf<{
      readonly app_version: "1.0.0";
      readonly release: {
        readonly flags: readonly [true, null, 3, "stable"];
      };
    }>().toMatchTypeOf<DatabaseBundleMetadata>();
    expectTypeOf<string>().not.toMatchTypeOf<DatabaseBundleMetadata>();
    expectTypeOf<readonly []>().not.toMatchTypeOf<DatabaseBundleMetadata>();
    expectTypeOf<bigint>().not.toMatchTypeOf<DatabaseBundleMetadata>();
    expectTypeOf<() => true>().not.toMatchTypeOf<DatabaseBundleMetadata>();
    expectTypeOf<{
      readonly nested: undefined;
    }>().not.toMatchTypeOf<DatabaseBundleMetadata>();
    expectTypeOf<{
      readonly nested: () => true;
    }>().not.toMatchTypeOf<DatabaseBundleMetadata>();
    expectTypeOf<{
      readonly app_version: 1;
    }>().not.toMatchTypeOf<DatabaseBundleMetadata>();
  });

  it("keeps transaction operations input-only", () => {
    expectTypeOf<TransactionDatabasePlugin["count"]>().parameters.toEqualTypeOf<
      [CountDatabaseImplementationInput]
    >();
    expectTypeOf<FindOneDatabaseInput<"bundle_patches">>().toMatchTypeOf<{
      readonly model: "bundle_patches";
    }>();
  });
});
