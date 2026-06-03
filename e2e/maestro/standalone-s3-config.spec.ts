import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const configSourcePath = path.resolve(
  import.meta.dirname,
  "../../examples/v0.85.0/hot-updater.config.ts",
);

async function readExampleHotUpdaterConfig(): Promise<string> {
  return fs.readFile(configSourcePath, "utf8");
}

describe("standalone-s3 example config", () => {
  it("uses local S3 storage instead of standalone HTTP upload when MinIO env exists", async () => {
    // Given: standalone-s3 runs the control server locally and storage in MinIO.
    const source = await readExampleHotUpdaterConfig();

    // When: the bot injects AWS_S3_ENDPOINT for the local MinIO bucket.
    const storageStart = source.indexOf("storage:");
    const databaseStart = source.indexOf("database:", storageStart);
    const storageSource = source.slice(storageStart, databaseStart);

    // Then: CLI uploads go directly to S3 instead of /hot-updater/upload.
    expect(source).toContain("const localS3StorageEndpoint");
    expect(storageSource).toMatch(/localS3StorageEndpoint\s+\?\s+s3Storage\(/);
    expect(storageSource).toContain("forcePathStyle: true");
    expect(storageSource.indexOf("localS3StorageEndpoint")).toBeLessThan(
      storageSource.indexOf("standaloneStorageBaseUrl"),
    );
  });
});
