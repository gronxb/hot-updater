import { describe, expect, it } from "vitest";

import { projectFeatureApis } from "./apiProjection";
import { HotUpdaterConstructionError } from "./errors";

const constructionCode = (callback: () => unknown): string | undefined => {
  try {
    callback();
    return undefined;
  } catch (error) {
    return error instanceof HotUpdaterConstructionError
      ? error.code
      : undefined;
  }
};

describe("projectFeatureApis", () => {
  it("installs aliases only for an available feature and freezes output", () => {
    // Given
    const getSummary = () => "summary";

    // When
    const available = projectFeatureApis({
      contributions: [
        {
          legacyAliases: { getSummary: "getSummary" },
          namespace: "analytics",
          value: { getSummary, status: "available" },
        },
      ],
      coreApiKeys: ["handler"],
    });
    const unavailable = projectFeatureApis({
      contributions: [
        {
          legacyAliases: { getSummary: "getSummary" },
          namespace: "analytics",
          value: { status: "unavailable" },
        },
      ],
      coreApiKeys: ["handler"],
    });

    // Then
    expect(available.aliases.getSummary).toBe(getSummary);
    expect(unavailable.aliases).toEqual({});
    expect(Object.isFrozen(available.features)).toBe(true);
    expect(Object.isFrozen(available.features.analytics)).toBe(true);
    expect(Object.isFrozen(available.aliases)).toBe(true);
  });

  it("rejects namespace, alias, core shadow, and missing-member conflicts", () => {
    // Given
    const value = { operation: () => undefined, status: "available" };
    const base = {
      legacyAliases: { legacyOperation: "operation" },
      namespace: "feature",
      value,
    };

    // When / Then
    expect(
      constructionCode(() =>
        projectFeatureApis({
          contributions: [base, base],
          coreApiKeys: [],
        }),
      ),
    ).toBe("DUPLICATE_API_NAMESPACE");
    expect(
      constructionCode(() =>
        projectFeatureApis({
          contributions: [base, { ...base, namespace: "other" }],
          coreApiKeys: [],
        }),
      ),
    ).toBe("DUPLICATE_API_ALIAS");
    expect(
      constructionCode(() =>
        projectFeatureApis({
          contributions: [base],
          coreApiKeys: ["legacyOperation"],
        }),
      ),
    ).toBe("DUPLICATE_API_ALIAS");
    expect(
      constructionCode(() =>
        projectFeatureApis({
          contributions: [
            {
              legacyAliases: { missing: "missing" },
              namespace: "feature",
              value,
            },
          ],
          coreApiKeys: [],
        }),
      ),
    ).toBe("DUPLICATE_API_ALIAS");
  });

  it("projects reserved object property names as inert own properties", () => {
    // Given / When
    const projected = projectFeatureApis({
      contributions: [
        {
          legacyAliases: { ["__proto__"]: "operation" },
          namespace: "__proto__",
          value: { operation: () => "safe", status: "available" },
        },
      ],
      coreApiKeys: [],
    });

    // Then
    expect(Object.hasOwn(projected.features, "__proto__")).toBe(true);
    expect(Object.hasOwn(projected.aliases, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(projected.features)).toBe(Object.prototype);
  });
});
