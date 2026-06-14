import { describe, expect, it } from "vitest";

import { createSettingsTable } from "./settings";
import { bundlesV021, v0_21_0 } from "./v0_21_0";
import { bundlesV029, v0_29_0 } from "./v0_29_0";
import { bundlesV031, v0_31_0 } from "./v0_31_0";

describe("versioned schema DSL", () => {
  it("uses the local functional DSL for every versioned schema table", () => {
    expect(v0_21_0.dsl).toBe("schema");
    expect(v0_29_0.dsl).toBe("schema");
    expect(v0_31_0.dsl).toBe("schema");

    expect(bundlesV021.dsl).toBe("table");
    expect(bundlesV029.dsl).toBe("table");
    expect(bundlesV031.dsl).toBe("table");
    expect(createSettingsTable("0.31.0").dsl).toBe("table");

    for (const schema of [v0_21_0, v0_29_0, v0_31_0]) {
      expect(Object.keys(schema)).not.toContain("dsl");
      for (const table of schema.tables) {
        expect(Object.keys(table)).not.toContain("dsl");
      }
    }
  });
});
