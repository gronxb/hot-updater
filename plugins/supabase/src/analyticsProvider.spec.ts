import { analytics } from "@hot-updater/analytics";
import { getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";
import { createHotUpdater } from "@hot-updater/server";
import { describe, expect, it } from "vitest";

import { supabaseDatabase } from "./supabaseDatabase";

describe("Supabase Analytics provider capability", () => {
  it("attaches one deferred capability without issuing a query", () => {
    // Given
    const config = {
      supabaseServiceRoleKey: "service-role-key",
      supabaseUrl: "https://example.supabase.co",
    };

    // When
    const database = supabaseDatabase(config);

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
      ...supabaseDatabase({
        supabaseServiceRoleKey: "service-role-key",
        supabaseUrl: "https://example.supabase.co",
      }),
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
