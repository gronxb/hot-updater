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

describe("Cloudflare Analytics provider capability", () => {
  it("attaches one deferred capability to the Worker database", () => {
    // Given
    const db = createD1();

    // When
    const database = d1WorkerDatabase(db);

    // Then
    expect(
      getCapabilityContributions(database).map(({ token }) => token.id),
    ).toEqual(["analytics-provider@1"]);
  });

  it("attaches one deferred capability to the API database", () => {
    // Given
    const config = {
      accountId: "account-id",
      cloudflareApiToken: "api-token",
      databaseId: "database-id",
    };

    // When
    const database = d1Database(config);

    // Then
    expect(
      getCapabilityContributions(database).map(({ token }) => token.id),
    ).toEqual(["analytics-provider@1"]);
  });

  it("fails strict construction when the provider wrapper is removed", () => {
    // Given
    const database = { ...d1WorkerDatabase(createD1()) };
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
