import { analytics } from "@hot-updater/analytics";
import { getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";
import { createHotUpdater } from "@hot-updater/server";
import { describe, expect, it } from "vitest";

import { firebaseDatabase } from "./firebaseDatabase";

describe("Firebase Analytics database ownership", () => {
  it("uses the bare database without running persistence", () => {
    // Given
    const config = { projectId: "analytics-capability-test" };

    // When
    const database = firebaseDatabase(config);

    // Then
    expect(getCapabilityContributions(database)).toEqual([]);
    expect(
      createHotUpdater({
        database,
        plugins: [analytics({ queryAccess: "public" })],
      }).features.analytics.status,
    ).toBe("available");
  });
});
