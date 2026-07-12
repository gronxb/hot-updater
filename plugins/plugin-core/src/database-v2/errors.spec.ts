import { describe, expect, it } from "vitest";

import { DatabaseConnectorErrorV2 } from "./errors";

describe("DatabaseConnectorErrorV2", () => {
  it("retains its typed identity when constructed with a connector code", () => {
    // Given
    const cause = new TypeError("invalid tenant claim");

    // When
    const error = new DatabaseConnectorErrorV2(
      "INVALID_SCOPE",
      "scope is invalid",
      { cause },
    );

    // Then
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("DatabaseConnectorErrorV2");
    expect(error.code).toBe("INVALID_SCOPE");
    expect(error.message).toBe("scope is invalid");
    expect(error.cause).toBe(cause);
  });
});
