import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import * as secretsApi from "./secrets";

describe("secrets exports", () => {
  it("exposes only the supported secrets adapters", () => {
    expect(Object.keys(secretsApi).sort()).toEqual([
      "awsSecretsManager",
      "env",
      "githubActions",
      "googleSecretManager",
      "infisical",
    ]);
  });

  it("reads env() from the environment, read-only", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-env-"));
    process.env["HOT_UPDATER_SPEC_RELEASE_KEYSTORE"] = '{"keystore":"a"}';
    try {
      const secrets = secretsApi.env();

      await expect(
        secrets.get(["spec-release-keystore", "SPEC_UNSET_NAME"], { cwd }),
      ).resolves.toEqual({
        "spec-release-keystore": '{"keystore":"a"}',
        SPEC_UNSET_NAME: undefined,
      });
      expect(secrets.name).toBe("env");
      expect(secrets.set).toBeUndefined();
    } finally {
      delete process.env["HOT_UPDATER_SPEC_RELEASE_KEYSTORE"];
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
