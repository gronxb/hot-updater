import { describe, expect, expectTypeOf, it } from "vitest";

import { s3Database, s3Storage } from "./lambda";

type LambdaContext = {
  readonly distributionDomainName: string;
};

describe("AWS Lambda runtime plugins", () => {
  it("exposes the database and CloudFront storage under provider names", () => {
    // Given: Lambda-native S3 and CloudFront configuration.
    const config = {
      bucketName: "hot-updater",
      region: "us-east-1",
      keyPairId: "key-pair",
      getPrivateKey: async () => "private-key",
      publicBaseUrl: (context?: LambdaContext) =>
        `https://${context?.distributionDomainName ?? "cdn.example.com"}`,
    };

    // When: the runtime factories are created.
    const database = s3Database(config);
    const storage = s3Storage<LambdaContext>(config)();

    // Then: the runtime surface preserves names and request context types.
    expect(database.name).toBe("s3Database");
    expect(storage.name).toBe("s3StorageWithCloudFrontSignedUrl");
    expectTypeOf(storage.profiles.runtime.getDownloadUrl)
      .parameter(1)
      .toEqualTypeOf<LambdaContext | undefined>();
  });
});
