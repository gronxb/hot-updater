import { describe, expect, it } from "vitest";

import { resolveFirebaseInfrastructureState } from "./firebaseInfrastructureState";

describe("Firebase infrastructure generation", () => {
  it.each([
    [{ adapterVersion: undefined, hasData: false }, "fresh"],
    [{ adapterVersion: 1, hasData: true }, "v0"],
    [{ adapterVersion: 3, hasData: false }, "v0"],
    [{ adapterVersion: undefined, hasData: true }, "v0"],
    [{ adapterVersion: 4, hasData: true }, "v1"],
  ] as const)("classifies %j as %s", (input, expected) => {
    expect(resolveFirebaseInfrastructureState(input)).toBe(expected);
  });
});
