import { describe, expect, it } from "vitest";

import { createCoreRouteDescriptors } from "./coreRoutes";

describe("createCoreRouteDescriptors", () => {
  it("keeps version and update check public while bundles default off", () => {
    // Given / When
    const routes = createCoreRouteDescriptors();

    // Then
    expect(routes.map(({ id }) => id)).toEqual([
      "core.version",
      "core.update.fingerprint",
      "core.update.fingerprint-cohort",
      "core.update.app-version",
      "core.update.app-version-cohort",
    ]);
    expect(routes.every(({ access }) => access.kind === "public")).toBe(true);
    expect(Object.isFrozen(routes)).toBe(true);
  });

  it("makes boolean bundle management protected and honors explicit public access", () => {
    // Given / When
    const protectedRoutes = createCoreRouteDescriptors({
      bundles: true,
      updateCheck: false,
    });
    const publicRoutes = createCoreRouteDescriptors({
      bundles: { access: { kind: "public" } },
      updateCheck: false,
    });

    // Then
    expect(
      protectedRoutes
        .slice(1)
        .every(({ access }) => access.kind === "protected"),
    ).toBe(true);
    expect(
      publicRoutes.slice(1).every(({ access }) => access.kind === "public"),
    ).toBe(true);
    expect(protectedRoutes[0]?.id).toBe("core.version");
  });

  it("copies and freezes custom bundle access", () => {
    // Given
    const access = { kind: "public" } as const;

    // When
    const routes = createCoreRouteDescriptors({
      bundles: { access },
      updateCheck: false,
    });

    // Then
    expect(
      routes.slice(1).every(({ access: value }) => Object.isFrozen(value)),
    ).toBe(true);
  });
});
