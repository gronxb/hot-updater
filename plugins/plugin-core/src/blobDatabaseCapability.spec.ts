import { describe, expect, expectTypeOf, it } from "vitest";

import { createBlobDatabaseAdapter } from "./createBlobDatabaseAdapter";
import {
  databaseAnalyticsSupport,
  databaseBundleEventService,
  type DatabaseBundleEventService,
} from "./types";

const createCapabilityFixture = () =>
  createBlobDatabaseAdapter({
    name: "blob-capability",
    adapter: () => ({
      apiBasePath: "/api/check-update",
      listObjects: async () => [],
      loadObject: async () => null,
      uploadObject: async () => undefined,
      compareAndSwapObject: async () => true,
      invalidatePaths: async () => undefined,
    }),
  });

describe("blob database capability", () => {
  it("cannot satisfy or advertise Analytics capability contracts", () => {
    type AnalyticsCapability = {
      readonly [databaseAnalyticsSupport]: true;
    };
    type BundleEventCapability = {
      readonly [databaseBundleEventService]: DatabaseBundleEventService;
    };

    expectTypeOf<
      ReturnType<typeof createBlobDatabaseAdapter>
    >().not.toMatchTypeOf<AnalyticsCapability>();
    expectTypeOf<
      ReturnType<typeof createBlobDatabaseAdapter>
    >().not.toMatchTypeOf<BundleEventCapability>();
    const adapter = createCapabilityFixture();

    expect(Reflect.get(adapter, databaseAnalyticsSupport)).toBeUndefined();
    expect(Reflect.get(adapter, databaseBundleEventService)).toBeUndefined();
  });
});
