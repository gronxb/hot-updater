import { afterEach, describe, expect, it } from "vitest";

import {
  createMissingFingerprintDependencyError,
  isMissingExpoFingerprintError,
} from "./dependency";

describe("loadExpoFingerprint", () => {
  afterEach(() => {
    delete process.env["npm_config_user_agent"];
  });

  it("creates install guidance for the missing optional peer", () => {
    process.env["npm_config_user_agent"] = "pnpm/10.33.0";

    const error = createMissingFingerprintDependencyError();

    expect(error.message).toContain(
      "@expo/fingerprint is required for fingerprint commands but is not installed.",
    );
    expect(error.message).toContain("pnpm add -D @expo/fingerprint");
  });

  it("detects missing @expo/fingerprint module errors", () => {
    const error = Object.assign(
      new Error("Cannot find package '@expo/fingerprint'"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );

    expect(isMissingExpoFingerprintError(error)).toBe(true);
    expect(isMissingExpoFingerprintError(new Error("boom"))).toBe(false);
  });
});
