import { describe, expectTypeOf, it } from "vitest";

import type {
  BundlePatchRow,
  BundleRow,
  DatabaseBundleMetadata,
  DatabaseChange,
  DatabasePlugin,
} from "./database";

describe("database plugin types", () => {
  it("exposes bundles and bundle patches as separate table ports", () => {
    expectTypeOf<
      DatabasePlugin["bundles"]["findById"]
    >().returns.resolves.toEqualTypeOf<BundleRow | null>();
    expectTypeOf<
      DatabasePlugin["bundlePatches"]["findByBundleIds"]
    >().returns.resolves.toEqualTypeOf<readonly BundlePatchRow[]>();
  });

  it("keeps table-specific changes discriminated", () => {
    expectTypeOf<{
      readonly table: "bundles";
      readonly operation: "insert";
      readonly row: BundlePatchRow;
    }>().not.toMatchTypeOf<DatabaseChange>();
    expectTypeOf<{
      readonly table: "bundle_patches";
      readonly operation: "insert";
      readonly row: BundleRow;
    }>().not.toMatchTypeOf<DatabaseChange>();
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
});
