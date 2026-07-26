import { describe, expect, expectTypeOf, it } from "vitest";

import {
  CONSTRUCTION_ERROR_CODES,
  HotUpdaterConstructionError,
  isHotUpdaterConstructionError,
  type HotUpdaterConstructionErrorCode,
  type HotUpdaterConstructionErrorDetails,
} from "../index";

describe("HotUpdaterConstructionError", () => {
  it("narrows caught unknown values by construction code", () => {
    // Given
    const caught: unknown = new HotUpdaterConstructionError(
      "DUPLICATE_ROUTE_ID",
      { routeId: "plugin.route" },
    );

    // When
    const matched = isHotUpdaterConstructionError(caught, "DUPLICATE_ROUTE_ID");

    // Then
    expect(matched).toBe(true);
    if (matched) {
      expect(caught.details.routeId).toBe("plugin.route");
      expectTypeOf(caught).toEqualTypeOf<
        HotUpdaterConstructionError<"DUPLICATE_ROUTE_ID">
      >();
    }
  });

  it("does not narrow a construction error to a different code", () => {
    // Given
    const caught: unknown = new HotUpdaterConstructionError(
      "DUPLICATE_ROUTE_ID",
      { routeId: "plugin.route" },
    );

    // When
    const matched = isHotUpdaterConstructionError(
      caught,
      "DUPLICATE_PLUGIN_ID",
    );

    // Then
    expect(matched).toBe(false);
  });

  it("preserves a literal code with frozen safe details", () => {
    // Given
    const details = { routeId: "plugin.route" };

    // When
    const error = new HotUpdaterConstructionError(
      "DUPLICATE_ROUTE_ID",
      details,
    );

    // Then
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("HotUpdaterConstructionError");
    expect(error.code).toBe("DUPLICATE_ROUTE_ID");
    expect(error.details).toEqual(details);
    expect(Object.isFrozen(error.details)).toBe(true);
    expect(error.message).not.toContain(details.routeId);
    expectTypeOf(error.code).toEqualTypeOf<"DUPLICATE_ROUTE_ID">();
  });

  it("publishes every stable construction code exactly once", () => {
    // Given / When
    const uniqueCodes = new Set(CONSTRUCTION_ERROR_CODES);

    // Then
    expect(uniqueCodes.size).toBe(CONSTRUCTION_ERROR_CODES.length);
    expectTypeOf<
      (typeof CONSTRUCTION_ERROR_CODES)[number]
    >().toEqualTypeOf<HotUpdaterConstructionErrorCode>();
    expectTypeOf<
      HotUpdaterConstructionErrorDetails["DUPLICATE_ROUTE_ID"]
    >().toEqualTypeOf<{ readonly routeId: string }>();
  });
});
