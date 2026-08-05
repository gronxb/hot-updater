import { getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";
import { describe, expect, it } from "vitest";

import { firebaseDatabase } from "./firebaseDatabase";

describe("Firebase Analytics provider capability", () => {
  it("attaches the Analytics provider explicitly to the database carrier", () => {
    const database = firebaseDatabase({
      projectId: "firebase-analytics-capability-test",
    });

    expect(
      getCapabilityContributions(database).map(({ token }) => token.id),
    ).toContain("hot-updater.analytics.provider@1");
  });
});
