import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createManagedAppSnippet,
  createManagedWorkerVariables,
  provisionManagedApiKey,
} from "./managedApiKey";

describe("Cloudflare managed API-key provisioning", () => {
  it("bootstraps and reuses the raw API key while exposing only its digest", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cloudflare-api-key-"));

    try {
      const first = await provisionManagedApiKey(cwd);
      const second = await provisionManagedApiKey(cwd);
      const env = await readFile(join(cwd, ".env.hotupdater"), "utf8");

      expect(second).toEqual(first);
      expect(env).toBe(`HOT_UPDATER_API_KEY=${first.apiKey}\n`);

      const variables = createManagedWorkerVariables({
        apiKeySha256: first.sha256,
        jwtSecret: "download-signing-secret",
      });
      const deploymentArtifact = JSON.stringify({ vars: variables });

      expect(variables).toEqual({
        API_KEY_SHA256: first.sha256,
        JWT_SECRET: "download-signing-secret",
      });
      expect(deploymentArtifact).not.toContain(first.apiKey);
      expect(deploymentArtifact).toContain(first.sha256);

      const initOutput = createManagedAppSnippet(
        "https://updates.example.com/api/check-update",
      );
      expect(initOutput).not.toContain(first.apiKey);
      expect(initOutput).toContain(
        'import { HOT_UPDATER_API_KEY } from "@env";',
      );
      expect(initOutput).toContain("const commonHeaders = Object.freeze({");
      expect(initOutput).toContain("requestHeaders: commonHeaders");
      expect(initOutput).toContain("analytics.recordAppReady(result)");
      expect(initOutput).not.toContain("process.env.HOT_UPDATER_API_KEY");
      expect(initOutput).not.toContain(
        "HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY",
      );
      expect(initOutput).not.toContain("HOT_UPDATER_CLOUDFLARE_API_TOKEN");
    } finally {
      await rm(cwd, { force: true, recursive: true });
    }
  });
});
