import { describe, expect, it } from "vitest";

import * as analyticsRoot from "./index";

describe("@hot-updater/analytics root", () => {
  it("keeps the legacy alias map internal", () => {
    expect(analyticsRoot).not.toHaveProperty("analyticsLegacyAliases");
  });
});
