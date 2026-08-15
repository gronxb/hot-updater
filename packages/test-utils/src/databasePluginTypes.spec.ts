// @ts-expect-error Provider authoring implementations are internal-only.
import type { DatabasePluginImplementation } from "@hot-updater/plugin-core";
// @ts-expect-error Raw CRUD is internal-only.
import type { DatabasePluginCrud } from "@hot-updater/plugin-core";
// @ts-expect-error Capability matrices are internal-only.
import type { DatabaseCapability } from "@hot-updater/plugin-core";
// @ts-expect-error Physical database fields are internal-only.
import type { databaseFields } from "@hot-updater/plugin-core";
import type {
  BundleRow,
  BundleRowUpdate,
  ChannelDeleteResult,
  ChannelRow,
  DatabaseChange,
  DatabaseCommitResult,
} from "@hot-updater/plugin-core";
import type {
  CountBundlesDatabaseInput,
  CountDatabaseModel,
  CreateDatabaseModel,
  DatabaseDeleteModel,
  DatabaseFindOneModel,
  DatabaseModel,
  SelectedDatabaseRow,
  UpdateBundleDatabaseInput,
} from "@hot-updater/plugin-core/internal";
import { describe, expectTypeOf, it } from "vitest";

describe("database plugin operation matrix", () => {
  it("keeps provider authoring symbols out of the public entrypoint", () => {
    expectTypeOf<DatabasePluginImplementation>();
    expectTypeOf<DatabasePluginCrud>();
    expectTypeOf<DatabaseCapability>();
    expectTypeOf<databaseFields>();
  });

  it("exposes create and findMany for all fixed models", () => {
    expectTypeOf<DatabaseModel>().toEqualTypeOf<
      | "bundles"
      | "bundle_patches"
      | "channels"
      | "bundle_events"
      | "client_access_keys"
    >();
    expectTypeOf<CreateDatabaseModel>().toEqualTypeOf<DatabaseModel>();
  });

  it("limits delete to bundles, bundle patches, and channels", () => {
    expectTypeOf<DatabaseDeleteModel>().toEqualTypeOf<
      "bundles" | "bundle_patches" | "channels"
    >();
  });

  it("limits findOne to models with read-by-selector support", () => {
    expectTypeOf<DatabaseFindOneModel>().toEqualTypeOf<
      "bundles" | "bundle_patches" | "channels" | "client_access_keys"
    >();
  });

  it("allows count across all readable models while preserving bundle aliases", () => {
    expectTypeOf<CountDatabaseModel>().toEqualTypeOf<
      "bundles" | "bundle_patches"
    >();
    expectTypeOf<
      UpdateBundleDatabaseInput["model"]
    >().toEqualTypeOf<"bundles">();
    expectTypeOf<
      CountBundlesDatabaseInput["model"]
    >().toEqualTypeOf<"bundles">();
  });

  it("narrows selected result fields", () => {
    expectTypeOf<
      SelectedDatabaseRow<"bundles", readonly ["id", "channel", "channel_id"]>
    >().toEqualTypeOf<Pick<BundleRow, "id" | "channel" | "channel_id">>();
  });

  it("uses normalized channel rows", () => {
    expectTypeOf<ChannelRow>().toEqualTypeOf<{
      readonly id: string;
      readonly name: string;
    }>();
  });

  it("requires channel names and ids to change together", () => {
    expectTypeOf<{
      readonly channel: string;
      readonly channel_id: string;
    }>().toMatchTypeOf<BundleRowUpdate>();
    expectTypeOf<{
      readonly channel: string;
    }>().not.toMatchTypeOf<BundleRowUpdate>();
    expectTypeOf<{
      readonly channel_id: string;
    }>().not.toMatchTypeOf<BundleRowUpdate>();
  });

  it("limits commit operations to insert, update, and delete", () => {
    expectTypeOf<DatabaseChange["operation"]>().toEqualTypeOf<
      "insert" | "update" | "delete"
    >();
    expectTypeOf<
      Extract<DatabaseChange, { readonly operation: "ensure" }>
    >().toEqualTypeOf<never>();
  });

  it("accepts channel deletion without exposing another operation name", () => {
    expectTypeOf<
      Extract<
        DatabaseChange,
        { readonly model: "channels"; readonly operation: "delete" }
      >
    >().toEqualTypeOf<{
      readonly model: "channels";
      readonly operation: "delete";
      readonly where: { readonly id: string };
    }>();
    expectTypeOf<ChannelDeleteResult>().toEqualTypeOf<
      | { readonly deleted: true }
      | {
          readonly deleted: false;
          readonly reason: "not_found" | "not_empty";
        }
    >();
    expectTypeOf<
      Extract<
        DatabaseCommitResult,
        { readonly committed: false }
      >["conflict"]["reason"]
    >().toEqualTypeOf<"not_found" | "referenced">();
  });

  it("only exposes onConflict on idempotent commit inserts", () => {
    expectTypeOf<
      Extract<
        DatabaseChange,
        { readonly model: "channels"; readonly operation: "insert" }
      >["onConflict"]
    >().toEqualTypeOf<"ignore">();
    expectTypeOf<
      Extract<
        DatabaseChange,
        { readonly model: "clientAccessKeys"; readonly operation: "insert" }
      >["onConflict"]
    >().toEqualTypeOf<"ignore">();
    expectTypeOf<
      keyof Extract<
        DatabaseChange,
        { readonly model: "bundles"; readonly operation: "insert" }
      >
    >().toEqualTypeOf<"model" | "operation" | "row">();
  });
});
