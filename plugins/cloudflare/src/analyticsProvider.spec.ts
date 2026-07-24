import { analytics } from "@hot-updater/analytics";
import { getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";
import { createHotUpdater } from "@hot-updater/server";
import { describe, expect, it } from "vitest";

import { d1WorkerDatabase, type D1Like } from "./cloudflareWorkerDatabase";
import { d1Database } from "./d1Database";

const createD1 = (): D1Like => ({
  prepare: () => ({
    bind: () => ({
      all: async () => ({ results: [] }),
    }),
  }),
});

describe("Cloudflare Analytics database ownership", () => {
  it("keeps the Worker database Analytics-agnostic", () => {
    // Given
    const db = createD1();

    // When
    const database = d1WorkerDatabase(db);

    // Then
    expect(getCapabilityContributions(database)).toEqual([]);
    expect(
      createHotUpdater({
        database,
        plugins: [analytics({ queryAccess: "public" })],
      }).features.analytics.status,
    ).toBe("available");
  });

  it("keeps the API database Analytics-agnostic", () => {
    // Given
    const config = {
      accountId: "account-id",
      cloudflareApiToken: "api-token",
      databaseId: "database-id",
    };

    // When
    const database = d1Database(config);

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
