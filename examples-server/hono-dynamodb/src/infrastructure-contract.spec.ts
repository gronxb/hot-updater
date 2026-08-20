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

describe("standalone-dynamodb local infrastructure contract", () => {
  it("uses local DynamoDB and MinIO services without billable AWS resources", async () => {
    const dockerCompose = await readProjectFile("docker-compose.yml");

    expect(dockerCompose).toContain("amazon/dynamodb-local:");
    expect(dockerCompose).toContain("minio/minio:");
    expect(dockerCompose).not.toContain("localstack");
    expect(dockerCompose).not.toContain("amazonaws.com");
  });

  it("configures DynamoDB metadata separately from S3 bundle storage", async () => {
    const dbSource = await readProjectFile("src/db.ts");

    expect(dbSource).toContain("export const database = dynamoDB({");
    expect(dbSource).toContain("s3Storage({");
    expect(dbSource).toMatch(
      /createHotUpdater\(\{\n  analytics: true,\n  clientAccessKeys: true,\n  database,/,
    );
    expect(dbSource).not.toContain("features:");
    expect(dbSource).not.toContain("routes:");
    expect(dbSource).not.toContain("plugins:");
    expect(dbSource).toContain(
      'endpoint: process.env.AWS_DYNAMODB_ENDPOINT ?? "http://localhost:8000"',
    );
    expect(dbSource).toContain(
      'endpoint: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9000"',
    );
  });
});
