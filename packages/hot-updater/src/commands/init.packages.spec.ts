import { describe, expect, it } from "vitest";

import { PACKAGE_MAP, REQUIRED_PACKAGES } from "./initPackages";

describe("managed init package requirements", () => {
  it("does not prescribe a React Native environment adapter", () => {
    expect(REQUIRED_PACKAGES).toEqual({
      dependencies: ["@hot-updater/react-native"],
      devDependencies: ["dotenv"],
    });
    expect(REQUIRED_PACKAGES.devDependencies).not.toContain(
      "react-native-dotenv",
    );
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
