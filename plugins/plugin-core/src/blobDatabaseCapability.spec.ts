import { describe, expect, expectTypeOf, it } from "vitest";

import { createBlobDatabasePlugin } from "./createBlobDatabasePlugin";
import {
  databaseAnalyticsSupport,
  databaseBundleEventService,
  type DatabaseBundleEventService,
} from "./types";

const createCapabilityFixture = () =>
  createBlobDatabasePlugin({
    name: "blob-capability",
    plugin: () => ({
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
      ReturnType<typeof createBlobDatabasePlugin>
    >().not.toMatchTypeOf<AnalyticsCapability>();
    expectTypeOf<
      ReturnType<typeof createBlobDatabasePlugin>
    >().not.toMatchTypeOf<BundleEventCapability>();
    const plugin = createCapabilityFixture();

    expect(Reflect.get(plugin, databaseAnalyticsSupport)).toBeUndefined();
    expect(Reflect.get(plugin, databaseBundleEventService)).toBeUndefined();
  });
});
