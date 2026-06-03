import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

async function readProjectFile(relativePath: string): Promise<string> {
  return await readFile(path.join(projectRoot, relativePath), "utf8");
}

describe("standalone-s3 local S3 contract", () => {
  it("uses MinIO instead of LocalStack for zero-cost local verification", async () => {
    // Given: the standalone-s3 profile depends on this example server's Docker Compose stack.
    const dockerCompose = await readProjectFile("docker-compose.yml");

    // When: the local S3 service contract is inspected.
    // Then: the contract is MinIO, not LocalStack or an external R2/S3 provider.
    expect(dockerCompose).toContain("minio:");
    expect(dockerCompose).toContain("minio/minio:");
    expect(dockerCompose).toContain("MINIO_ROOT_USER");
    expect(dockerCompose).not.toContain("localstack");
    expect(dockerCompose).not.toContain("4566:4566");
  });

  it("defaults test-mode S3 storage to the local MinIO endpoint", async () => {
    // Given: no AWS_S3_ENDPOINT override is supplied during local test-mode server startup.
    const dbSource = await readProjectFile("src/db.ts");

    // When: the test-mode fallback endpoint is inspected.
    // Then: S3-compatible storage points at local MinIO.
    expect(dbSource).toContain(
      'endpoint: process.env.AWS_S3_ENDPOINT || "http://localhost:9000"',
    );
    expect(dbSource).not.toContain("http://localhost:4566");
    expect(dbSource).not.toContain("localstack s3");
  });
});
