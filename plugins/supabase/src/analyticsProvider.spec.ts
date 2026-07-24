import { analytics } from "@hot-updater/analytics";
import { getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";
import { createHotUpdater } from "@hot-updater/server";
import { describe, expect, it } from "vitest";

import { supabaseDatabase } from "./supabaseDatabase";

describe("Supabase Analytics database ownership", () => {
  it("uses the bare database without issuing a query", () => {
    // Given
    const config = {
      supabaseServiceRoleKey: "service-role-key",
      supabaseUrl: "https://example.supabase.co",
    };

    // When
    const database = supabaseDatabase(config);

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
