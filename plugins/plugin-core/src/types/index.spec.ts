import { describe, expectTypeOf, it } from "vitest";

// @ts-expect-error Provider authoring types are internal-only.
import type { DatabasePluginImplementation as PublicDatabaseImplementation } from "../index";
// @ts-expect-error Raw CRUD is not part of the public database contract.
import type { DatabasePluginCrud as PublicDatabaseCrud } from "../index";
// @ts-expect-error Capability registries are not public API.
import type { DatabaseCapability as PublicDatabaseCapability } from "../index";
// @ts-expect-error Raw query clauses are provider-authoring details.
import type { DatabaseWhere as PublicDatabaseWhereGeneric } from "../index";
// @ts-expect-error Callback transaction implementations are internal-only.
import type { TransactionDatabasePluginImplementation as PublicTransactionImplementation } from "../index";
// @ts-expect-error Raw model-field registries are internal-only.
import { databaseFields as publicDatabaseFields } from "../index";
// @ts-expect-error Factory composition details are not public API.
import type { DatabasePluginAdapter as PublicDatabasePluginAdapter } from "../index";
// @ts-expect-error Redundant public Core aliases are intentionally absent.
import type { DatabasePluginCore as PublicDatabasePluginCore } from "../index";
// @ts-expect-error Redundant public Core aliases are intentionally absent.
import type { BundleRepositoryCore as PublicBundleRepositoryCore } from "../index";
import type { DatabaseBundleCursor, DatabaseBundleQueryOptions } from "./index";

type PublicDatabaseWhere = PublicDatabaseWhereGeneric<"bundles">;

type InternalDatabaseImplementation =
  import("../internal").DatabasePluginImplementation;
type InternalDatabaseCrud = import("../internal").DatabasePluginCrud;
type InternalDatabaseCapability = import("../internal").DatabaseCapability;
type InternalDatabaseWhere = import("../internal").DatabaseWhere<"bundles">;
type InternalDatabasePluginAdapter =
  import("../internal").DatabasePluginAdapter;

void (0 as unknown as PublicDatabaseImplementation);
void (0 as unknown as PublicDatabaseCrud);
void (0 as unknown as PublicDatabaseCapability);
void (0 as unknown as PublicDatabaseWhere);
void (0 as unknown as PublicTransactionImplementation);
void publicDatabaseFields;
void (0 as unknown as PublicDatabasePluginAdapter);
void (0 as unknown as PublicDatabasePluginCore);
void (0 as unknown as PublicBundleRepositoryCore);
void (0 as unknown as InternalDatabaseImplementation);
void (0 as unknown as InternalDatabaseCrud);
void (0 as unknown as InternalDatabaseCapability);
void (0 as unknown as InternalDatabaseWhere);
void (0 as unknown as InternalDatabasePluginAdapter);

describe("database bundle pagination types", () => {
  it("excludes competing cursor directions", () => {
    expectTypeOf<{
      readonly after: "004";
      readonly before: "002";
    }>().not.toMatchTypeOf<DatabaseBundleCursor>();
    expectTypeOf<
      Readonly<Record<string, never>>
    >().not.toMatchTypeOf<DatabaseBundleCursor>();
  });

  it("excludes page and cursor combinations", () => {
    expectTypeOf<{
      readonly limit: 2;
      readonly page: 2;
      readonly cursor: { readonly after: "004" };
    }>().not.toMatchTypeOf<DatabaseBundleQueryOptions>();
  });
});
