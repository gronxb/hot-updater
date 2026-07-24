import { describe, expect, it } from "vitest";

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";
import { isDatabasePlugin } from "./types";

describe("isDatabasePlugin", () => {
  it("accepts a direct fixed-model plugin object", () => {
    // Given
    const plugin = createInMemoryDatabasePlugin();

    // When
    const result = isDatabasePlugin(plugin);

    // Then
    expect(result).toBe(true);
  });

  it("rejects a v1 factory and non-callable CRUD fields", () => {
    // Given
    const plugin = createInMemoryDatabasePlugin();
    const factory = () => plugin;
    const malformed = { ...plugin, findMany: null };

    // When
    const factoryResult = isDatabasePlugin(factory);
    const malformedResult = isDatabasePlugin(malformed);

    // Then
    expect(factoryResult).toBe(false);
    expect(malformedResult).toBe(false);
  });
});
