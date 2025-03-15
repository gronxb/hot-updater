import { describe, expect, it } from "vitest";
import { transformEnv } from "./transformEnv";

describe("transformEnv", () => {
  it("should replace HotUpdater.S3_REGION with 'hello'", async () => {
    const code = "const s3 = new S3Client({ region: HotUpdater.S3_REGION });";

    const result = await transformEnv(code, { S3_REGION: "us-east-1" });
    expect(result).toContain('region: "us-east-1"');
  });

  it("should not modify other code", async () => {
    const code = `
      const otherCode = "test";
      const region = "us-east-1";
    `;

    const result = await transformEnv(code, { S3_REGION: "hello" });
    expect(result).toContain(`"test"`);
    expect(result).toContain(`"us-east-1"`);
  });

  it("should replace all occurrences of HotUpdater.S3_REGION", async () => {
    const code = `
      const s3_1 = new S3Client({
        region: HotUpdater.S3_REGION,
      });
      const s3_2 = new S3Client({
        region: HotUpdater.S3_REGION,
      });
    `;

    const result = await transformEnv(code, { S3_REGION: "hello" });
    const matches = result.match(/"hello"/g);
    expect(matches?.length).toBe(2);
  });

  it("should replace all occurrences of HotUpdater.S3_REGION", async () => {
    const code = `
      const s3_1 = new S3Client({
        region: HotUpdater.S3_REGION,
      });
      const s3_2 = new S3Client({
        region: HotUpdater.S3_REGION,
      });

      console.log(HotUpdater.S3_BUCKET_NAME);
    `;

    const result = await transformEnv(code, {
      S3_REGION: "ap-northeast-1",
      S3_BUCKET_NAME: "bundles",
    });
    const matches = result.match(/"ap-northeast-1"/g);
    expect(matches?.length).toBe(2);
    const matches2 = result.match(/"bundles"/g);
    expect(matches2?.length).toBe(1);
  });
});
