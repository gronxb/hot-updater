import { describe, expect, it } from "vitest";

import { PACKAGE_MAP, REQUIRED_PACKAGES } from "./initPackages";

describe("managed init package requirements", () => {
  it("installs the React Native environment adapter for every provider", () => {
    expect(REQUIRED_PACKAGES).toEqual({
      dependencies: ["@hot-updater/react-native"],
      devDependencies: ["dotenv", "react-native-dotenv"],
    });
  });

  it.each(["cloudflare", "firebase", "supabase"] as const)(
    "installs the Analytics client for the %s managed preset",
    (provider) => {
      expect(PACKAGE_MAP[provider].dependencies).toEqual([
        "@hot-updater/analytics",
      ]);
    },
  );

  it("keeps the AWS managed preset core-only", () => {
    expect(PACKAGE_MAP.aws.dependencies).toEqual([]);
  });
});
