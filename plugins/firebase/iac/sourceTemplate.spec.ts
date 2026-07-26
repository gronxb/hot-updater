import { describe, expect, it } from "vitest";

import { renderFirebaseSourceTemplate } from "./sourceTemplate";

describe("Firebase managed React Native source template", () => {
  it("uses the allowlisted client key for update checks and Analytics", () => {
    const source = renderFirebaseSourceTemplate(
      "https://updates.example.com/api/check-update",
    );

    expect(source).toContain('import { HOT_UPDATER_API_KEY } from "@env";');
    expect(source).toContain("const commonHeaders = Object.freeze({");
    expect(source.match(/requestHeaders: commonHeaders/gmu)).toHaveLength(2);
    expect(source).toContain("analytics.recordAppReady(result)");
    expect(source).not.toContain("process.env.HOT_UPDATER_API_KEY");
    expect(source).not.toContain("GOOGLE_APPLICATION_CREDENTIALS");
  });
});
