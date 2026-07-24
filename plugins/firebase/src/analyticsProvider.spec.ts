import { analytics } from "@hot-updater/analytics";
import { getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";
import { createHotUpdater } from "@hot-updater/server";
import { describe, expect, it } from "vitest";

import { firebaseDatabase } from "./firebaseDatabase";

describe("Firebase Analytics provider capability", () => {
  it("attaches one deferred capability without running persistence", () => {
    // Given
    const config = { projectId: "analytics-capability-test" };

    // When
    const database = firebaseDatabase(config);

    // Then
    expect(
      getCapabilityContributions(database).map(({ token }) => token.id),
    ).toEqual(["analytics-provider@1"]);
    expect(
      createHotUpdater({
        database,
        plugins: [
          analytics({
            missingCapability: "error",
            queryAccess: "public",
          }),
        ],
      }).features.analytics.status,
    ).toBe("available");
  });

  it("fails strict construction when the provider wrapper is removed", () => {
    // Given
    const database = {
      ...firebaseDatabase({ projectId: "analytics-capability-test" }),
    };
    const plugin = analytics({
      missingCapability: "error",
      queryAccess: "public",
    });

    // When
    const construct = () =>
      createHotUpdater({
        database,
        plugins: [plugin],
      });

    // Then
    expect(construct).toThrowError(
      expect.objectContaining({ code: "MISSING_CAPABILITY" }),
    );
  });
});
