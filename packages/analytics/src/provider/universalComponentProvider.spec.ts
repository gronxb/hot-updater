import type { UniversalComponentDataSource } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import { analyticsComponentSchema } from "../componentSchema";
import { createUniversalComponentAnalyticsProvider } from "./universalComponentProvider";

const createSource = (
  assertReady: UniversalComponentDataSource["assertReady"],
): UniversalComponentDataSource => ({
  schema: analyticsComponentSchema,
  append: async () => undefined,
  assertReady,
  orderedScan: async () => [],
});

describe("universal component Analytics provider", () => {
  it("creates a bounded provider without changing route availability", () => {
    const provider = createUniversalComponentAnalyticsProvider(
      createSource(async () => undefined),
    );

    expect(provider.mode).toBe("bounded");
    expect(provider.resolveAvailability).toBeUndefined();
    expect(Object.isFrozen(provider)).toBe(true);
  });
});
