import { describe, expect, it } from "vitest";

import { readErrorDetails } from "./errorDetails";

describe("Insights original error details", () => {
  it("preserves messages and stacks from Error and native rejection objects", () => {
    const error = new Error(
      "Cannot read catalog at https://example.com/catalog?generation=2",
    );
    error.stack =
      "Error: original message\n    at checkForUpdate (app.js:42:1)";
    expect(readErrorDetails(error)).toEqual({
      errorMessage: error.message,
      errorStack: error.stack,
    });
    expect(
      readErrorDetails({
        message: "Native failure (-1001)",
        stack: "native frame",
      }),
    ).toEqual({
      errorMessage: "Native failure (-1001)",
      errorStack: "native frame",
    });
    expect(readErrorDetails("plain rejection")).toEqual({
      errorMessage: "plain rejection",
    });
    expect(readErrorDetails({ code: "E_CUSTOM", detail: 42 })).toEqual({
      errorMessage: '{"code":"E_CUSTOM","detail":42}',
    });
    expect(readErrorDetails(undefined)).toEqual({});
  });

  it.each(["한😀", '\u0000"\\'])(
    "bounds JSON wire bytes for oversized text without splitting characters: %j",
    (text) => {
      const details = readErrorDetails({
        message: text.repeat(3_000),
        stack: text.repeat(6_000),
      });
      expect(
        Buffer.byteLength(JSON.stringify(details.errorMessage)),
      ).toBeLessThanOrEqual(2_048);
      expect(
        Buffer.byteLength(JSON.stringify(details.errorStack)),
      ).toBeLessThanOrEqual(4_096);
      expect(details.errorMessage?.endsWith("…")).toBe(true);
      expect(details.errorStack?.endsWith("…")).toBe(true);
      expect(details.errorMessage?.isWellFormed()).toBe(true);
      expect(details.errorStack?.isWellFormed()).toBe(true);
    },
  );
});
