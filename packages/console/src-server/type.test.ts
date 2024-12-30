import type { Bundle } from "@hot-updater/utils";
import type * as v from "valibot";
import { describe, expectTypeOf, it } from "vitest";
import type { bundleSchema } from "./rpc";

type BundleInput = v.InferInput<typeof bundleSchema>;

describe("Bundle type test", () => {
  it("should have same type", () => {
    expectTypeOf<BundleInput>().toEqualTypeOf<Bundle>();
  });
});
