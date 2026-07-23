import { describe, expectTypeOf, it } from "vitest";

import type {
  BundleEventRow,
  BundleRow,
  CountDatabaseInput,
  DatabasePlugin,
  DatabaseModel,
  DeleteDatabaseInput,
  FindManyDatabaseInput,
  FindOneDatabaseInput,
  TransactionDatabasePlugin,
} from "./database";
import type {
  ActiveInstallationOverview,
  ActiveInstallationWindow,
  CreateBundleEventRequest,
  DatabaseBundleEventService,
} from "./databaseBundleEvents";

describe("database plugin types", () => {
  it("keeps unsupported model and operation pairs outside the contract", () => {
    type EventDelete = { readonly model: "bundle_events" };

    expectTypeOf<"channels">().not.toMatchTypeOf<DatabaseModel>();
    expectTypeOf<EventDelete>().not.toMatchTypeOf<
      DeleteDatabaseInput<"bundles" | "bundle_patches">
    >();
    expectTypeOf<{ readonly model: "bundle_events" }>().toMatchTypeOf<
      CountDatabaseInput<"bundle_events">
    >();
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
    expectTypeOf<FindManyDatabaseInput<"bundle_events">>().not.toMatchTypeOf<{
      readonly model: "bundle_events";
      readonly orderBy: readonly [
        { readonly field: "metadata"; readonly direction: "asc" },
      ];
    }>();
  });

  it("supports latest-per-install distinctOn ordering for bundle events", () => {
    const exerciseLatestPerInstall = async (plugin: DatabasePlugin) => {
      const rows = await plugin.findMany({
        model: "bundle_events",
        distinctOn: { fields: ["install_id"] },
        orderBy: [
          { field: "install_id", direction: "asc" },
          { field: "received_at_ms", direction: "desc" },
          { field: "id", direction: "desc" },
        ],
        select: ["id", "install_id", "received_at_ms"],
      });

      expectTypeOf(rows).toEqualTypeOf<
        Pick<BundleEventRow, "id" | "install_id" | "received_at_ms">[]
      >();
    };

    expectTypeOf(exerciseLatestPerInstall).toBeFunction();
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

  it("keeps transaction operations input-only", () => {
    expectTypeOf<TransactionDatabasePlugin["count"]>().parameters.toEqualTypeOf<
      [CountDatabaseInput<"bundles" | "bundle_patches" | "bundle_events">]
    >();
    expectTypeOf<FindOneDatabaseInput<"bundle_patches">>().toMatchTypeOf<{
      readonly model: "bundle_patches";
    }>();
  });

  it("correlates event variants with transition-only fields", () => {
    type AppliedRow = Extract<
      BundleEventRow,
      { readonly type: "UPDATE_APPLIED" }
    >;
    type RecoveredRow = Extract<BundleEventRow, { readonly type: "RECOVERED" }>;
    type UnchangedRow = Extract<BundleEventRow, { readonly type: "UNCHANGED" }>;
    type AppliedRequest = Extract<
      CreateBundleEventRequest,
      { readonly type: "UPDATE_APPLIED" }
    >;
    type UnchangedRequest = Extract<
      CreateBundleEventRequest,
      { readonly type: "UNCHANGED" }
    >;

    expectTypeOf<AppliedRow["from_bundle_id"]>().toEqualTypeOf<string>();
    expectTypeOf<RecoveredRow["update_strategy"]>().toEqualTypeOf<
      "fingerprint" | "appVersion"
    >();
    expectTypeOf<UnchangedRow["from_bundle_id"]>().toEqualTypeOf<null>();
    expectTypeOf<UnchangedRow["update_strategy"]>().toEqualTypeOf<null>();
    expectTypeOf<AppliedRequest["fromBundleId"]>().toEqualTypeOf<string>();
    expectTypeOf<UnchangedRequest["fromBundleId"]>().toEqualTypeOf<null>();
    expectTypeOf<UnchangedRequest["updateStrategy"]>().toEqualTypeOf<null>();
  });

  it("exposes the bounded active installation overview contract", () => {
    expectTypeOf<ActiveInstallationWindow>().toEqualTypeOf<
      "24h" | "7d" | "30d"
    >();
    expectTypeOf<ActiveInstallationOverview>().toMatchTypeOf<{
      readonly asOfMs: number;
      readonly window: ActiveInstallationWindow;
      readonly activeInstallations: number;
      readonly series: readonly {
        readonly bucketStartMs: number;
        readonly value: number;
      }[];
      readonly bundleSeries: readonly {
        readonly bundleId: string;
        readonly series: readonly {
          readonly bucketStartMs: number;
          readonly value: number;
        }[];
      }[];
      readonly bundles: readonly {
        readonly bundleId: string;
        readonly installations: number;
      }[];
    }>();
    expectTypeOf<
      DatabaseBundleEventService["getActiveInstallationOverview"]
    >().toBeFunction();
  });
});
