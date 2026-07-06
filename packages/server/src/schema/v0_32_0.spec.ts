import { describe, expect, it } from "vitest";

import { createTableStatement } from "../db/schema/sql";
import { bundleEventsV032, v0_32_0 } from "./v0_32_0";

describe("bundleEventsV032", () => {
  it("uses the functional schema DSL for the v0.32.0 bundle events table", () => {
    expect(v0_32_0.dsl).toBe("schema");
    expect(bundleEventsV032.dsl).toBe("table");
    expect(bundleEventsV032.columns).toEqual([
      { ormName: "id", type: "uuid", primaryKey: true },
      { ormName: "kind", type: "string" },
      { ormName: "install_id", type: "string" },
      { ormName: "active_bundle_id", type: "uuid" },
      {
        ormName: "previous_active_bundle_id",
        type: "uuid",
        nullable: true,
      },
      { ormName: "crashed_bundle_id", type: "uuid", nullable: true },
      { ormName: "platform", type: "string" },
      { ormName: "channel", type: "string" },
      { ormName: "app_version", type: "string", nullable: true },
      { ormName: "fingerprint_hash", type: "string", nullable: true },
      { ormName: "cohort", type: "string", nullable: true },
      { ormName: "payload", type: "json" },
    ]);
    expect(bundleEventsV032.indexes).toEqual([
      { name: "bundle_events_install_id_idx", columns: ["install_id"] },
      {
        name: "bundle_events_active_bundle_id_idx",
        columns: ["active_bundle_id"],
      },
      {
        name: "bundle_events_platform_channel_idx",
        columns: ["platform", "channel"],
      },
    ]);
    expect(Object.keys(bundleEventsV032)).not.toContain("dsl");
    expect(createTableStatement(bundleEventsV032, "postgresql")).toContain(
      "payload json not null",
    );
  });
});
