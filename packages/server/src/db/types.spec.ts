import { describe, expect, it } from "vitest";

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";
import { isDatabasePlugin } from "./types";

describe("isDatabasePlugin", () => {
  it("accepts a direct fixed-model plugin object", () => {
    const plugin = createInMemoryDatabasePlugin();

    const result = isDatabasePlugin(plugin);

    expect(result).toBe(true);
  });

  it("rejects a v1 factory and non-callable domain fields", () => {
    const plugin = createInMemoryDatabasePlugin();
    const factory = () => plugin;
    const malformed = {
      ...plugin,
      bundles: { ...plugin.bundles, findMany: null },
    };

    const factoryResult = isDatabasePlugin(factory);
    const malformedResult = isDatabasePlugin(malformed);

    expect(factoryResult).toBe(false);
    expect(malformedResult).toBe(false);
  });
});
