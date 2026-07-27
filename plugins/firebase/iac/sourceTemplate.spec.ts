import { describe, expect, it } from "vitest";

import { renderFirebaseSourceTemplate } from "./sourceTemplate";

describe("Firebase managed React Native source template", () => {
  it("uses a direct client key placeholder for update checks and Analytics", () => {
    const source = renderFirebaseSourceTemplate(
      "https://updates.example.com/api/check-update",
    );

    expect(source).toContain('"x-api-key": "<managed-client-access-key>"');
    expect(source).toContain("const commonHeaders = Object.freeze({");
    expect(source.match(/requestHeaders: commonHeaders/gmu)).toHaveLength(2);
    expect(source).toContain("analytics.recordAppReady(result)");
    expect(source).not.toContain("hotUpdaterClientApiKey");
    expect(source).not.toContain("hotUpdaterClientConfig");
    expect(source).not.toContain('from "@env"');
    expect(source).not.toContain("react-native-dotenv");
    expect(source).not.toContain("process.env.HOT_UPDATER_API_KEY");
    expect(source).not.toContain("GOOGLE_APPLICATION_CREDENTIALS");
    expect(source).toContain("return null;");
    expect(source).not.toContain("return ...");
  });
});
