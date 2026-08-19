import { describe, expect, it } from "vitest";

import { hotUpdaterSchemaVersions } from "./index";
import { createSettingsTable } from "./settings";
import {
  bundlePatchesV100,
  bundlesV100,
  channelsV100,
  releaseCatalogsV100,
  releasesV100,
  v1_0_0,
} from "./v1_0_0";

describe("versioned schema DSL", () => {
  it("uses the local functional DSL for the current schema", () => {
    expect(v1_0_0.dsl).toBe("schema");
    expect(channelsV100.dsl).toBe("table");
    expect(bundlesV100.dsl).toBe("table");
    expect(bundlePatchesV100.dsl).toBe("table");
    expect(releasesV100.dsl).toBe("table");
    expect(releaseCatalogsV100.dsl).toBe("table");
    expect(createSettingsTable("1.0.0").dsl).toBe("table");

    expect(Object.keys(v1_0_0)).not.toContain("dsl");
    for (const table of v1_0_0.tables) {
      expect(Object.keys(table)).not.toContain("dsl");
    }
  });

  it("registers only schema 1.0.0", () => {
    expect(hotUpdaterSchemaVersions.map((item) => item.version)).toEqual([
      "1.0.0",
    ]);
  });
});
