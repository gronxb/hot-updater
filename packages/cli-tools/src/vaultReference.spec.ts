import { describe, expect, it } from "vitest";

import { parseVaultReference } from "./vaultReference";

describe("parseVaultReference", () => {
  it("reads the secret name of vault:<name>", () => {
    expect(
      parseVaultReference("vault:release-keystore", "signing.keystore"),
    ).toBe("release-keystore");
    expect(parseVaultReference("vault:asc.key_2", "signing.ascApiKey")).toBe(
      "asc.key_2",
    );
  });

  it.each([
    "release-keystore",
    "vault:",
    "vault:-key",
    "vault:a b",
    `vault:${"a".repeat(65)}`,
  ])("refuses %j, naming the field", (reference) => {
    expect(() => parseVaultReference(reference, "signing.keystore")).toThrow(
      `signing.keystore names a vault secret as vault:<name>, such as "vault:release-keystore", and ${JSON.stringify(reference)} is not one.`,
    );
  });
});
