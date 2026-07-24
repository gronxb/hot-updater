import { describe, expect, it } from "vitest";

import packageJson from "../../package.json" with { type: "json" };

describe("first-party plugin authoring entry", () => {
  it("publishes only the unsupported internal subpath", () => {
    // Given
    const exports = packageJson.exports;

    // When
    const internalEntry = Reflect.get(exports, "./internal/first-party-plugin");

    // Then
    expect(internalEntry).toEqual({
      import: {
        types: "./dist/internal/first-party-plugin.d.mts",
        default: "./dist/internal/first-party-plugin.mjs",
      },
      require: {
        types: "./dist/internal/first-party-plugin.d.cts",
        default: "./dist/internal/first-party-plugin.cjs",
      },
    });
  });
});
