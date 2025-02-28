import { describe, expect, it } from "vitest";
import { defineRegion } from "./define-region";

describe("defineRegion", () => {
  it("should replace HotUpdater.S3_REGION with 'hello'", async () => {
    const code = "const s3 = new S3Client({ region: HotUpdater.S3_REGION });";

    const result = await defineRegion(code, "us-east-1");
    expect(result).toContain('region: "us-east-1"');
  });

  it("should not modify other code", async () => {
    const code = `
      const otherCode = "test";
      const region = "us-east-1";
    `;

    const result = await defineRegion(code, "hello");
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

    const result = await defineRegion(code, "hello");
    const matches = result.match(/"hello"/g);
    expect(matches?.length).toBe(2);
  });
});
