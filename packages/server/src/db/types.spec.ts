import { describe, expect, it } from "vitest";

import { createInMemoryDatabaseAdapter } from "../../../test-utils/test/inMemoryDatabaseAdapter";
import { isDatabasePlugin } from "./types";

describe("isDatabasePlugin", () => {
  it("accepts a direct v2 low adapter object", () => {
    // Given
    const adapter = createInMemoryDatabaseAdapter();

    // When
    const result = isDatabasePlugin(adapter);

    // Then
    expect(result).toBe(true);
  });

  it("rejects a v1 factory and non-callable CRUD fields", () => {
    // Given
    const adapter = createInMemoryDatabaseAdapter();
    const factory = () => adapter;
    const malformed = { ...adapter, findMany: null };

    // When
    const factoryResult = isDatabasePlugin(factory);
    const malformedResult = isDatabasePlugin(malformed);

    // Then
    expect(factoryResult).toBe(false);
    expect(malformedResult).toBe(false);
  });
});
