import type {
  BundleRow,
  ChannelRow,
  CountBundlesDatabaseInput,
  DatabaseDeleteModel,
  DatabaseFindOneModel,
  DatabaseModel,
  SelectedDatabaseRow,
  UpdateBundleDatabaseInput,
} from "@hot-updater/plugin-core";
import { describe, expectTypeOf, it } from "vitest";

describe("database adapter operation matrix", () => {
  it("exposes create and findMany for all fixed models", () => {
    expectTypeOf<DatabaseModel>().toEqualTypeOf<
      "bundles" | "bundle_patches" | "channels"
    >();
  });

  it("limits delete to bundles and bundle patches", () => {
    expectTypeOf<DatabaseDeleteModel>().toEqualTypeOf<
      "bundles" | "bundle_patches"
    >();
  });

  it("limits findOne to bundles and channels", () => {
    expectTypeOf<DatabaseFindOneModel>().toEqualTypeOf<
      "bundles" | "channels"
    >();
  });

  it("limits update and count to bundles", () => {
    expectTypeOf<
      UpdateBundleDatabaseInput["model"]
    >().toEqualTypeOf<"bundles">();
    expectTypeOf<
      CountBundlesDatabaseInput["model"]
    >().toEqualTypeOf<"bundles">();
  });

  it("narrows selected result fields", () => {
    expectTypeOf<
      SelectedDatabaseRow<"channels", readonly ["id", "name"]>
    >().toEqualTypeOf<ChannelRow>();
    expectTypeOf<
      SelectedDatabaseRow<"bundles", readonly ["id", "channel_id"]>
    >().toEqualTypeOf<Pick<BundleRow, "id" | "channel_id">>();
  });
});
