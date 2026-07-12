import { describe, expect, it } from "vitest";

describe("database-v2 conformance public surface", () => {
  it("exports the reusable structural suite", async () => {
    // Given
    const testUtils = await import("./index");

    // When
    const candidate = Reflect.get(
      testUtils,
      "setupDatabaseConnectorV2TestSuite",
    );

    // Then
    expect(candidate).toBeTypeOf("function");
  });
});
