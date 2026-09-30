import type { CloudFrontRequestEvent } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dynamoDB: vi.fn(() => ({ name: "dynamoDB" })),
  s3Storage: vi.fn(),
}));

vi.mock("../src/dynamoDB", () => ({
  dynamoDB: mocks.dynamoDB,
  migrateDynamoDB: vi.fn(),
}));

vi.mock("../src/s3Storage", () => ({
  s3Storage: mocks.s3Storage.mockImplementation((config) => ({
    name: "s3Storage",
    protocol: "s3",
    config,
  })),
}));

// Signs nothing: the URL shows which distribution it was signed for.
vi.mock("../src/cloudFrontDownloadUrl", () => ({
  cloudFrontDownloadUrl:
    ({ publicBaseUrl }: { publicBaseUrl: string }) =>
    async ({ storageUri }: { storageUri: string }) => ({
      url: `${publicBaseUrl}${new URL(storageUri).pathname}`,
    }),
}));

const event = (distributionDomainName: string): CloudFrontRequestEvent => ({
  Records: [
    {
      cf: {
        config: {
          distributionDomainName,
          distributionId: "dist-id",
          eventType: "origin-request",
          requestId: "request-id",
        },
        request: {
          clientIp: "127.0.0.1",
          headers: {
            host: [{ key: "host", value: "bucket.s3.amazonaws.com" }],
          },
          method: "GET",
          querystring: "",
          uri: "/manifest",
        },
      },
    },
  ],
});

const bodyOf = (response: unknown) => {
  const body = (response as { body?: string } | undefined)?.body ?? "";
  return JSON.parse(
    /^[A-Za-z0-9+/=]+$/u.test(body)
      ? Buffer.from(body, "base64").toString("utf8")
      : body,
  ) as unknown;
};

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.HotUpdater = {
    CLOUDFRONT_KEY_PAIR_ID: "KTEST",
    DYNAMODB_REGION: "ap-northeast-2",
    DYNAMODB_TABLE_NAME: "hot-updater-metadata",
    SSM_PARAMETER_NAME: "/hot-updater/test",
    SSM_REGION: "ap-northeast-2",
    S3_BUCKET_NAME: "hot-updater-bundles",
  };
});

describe("the managed Lambda@Edge runtime module", () => {
  it("serves the definition on the table and bucket init set up, not the CLI's", async () => {
    const { dynamoDB, s3Storage } = await import("./managed");

    dynamoDB({ tableName: "the CLI's", region: "the CLI's" });
    s3Storage({ bucketName: "the CLI's", credentials: "the CLI's" });

    expect(mocks.dynamoDB).toHaveBeenCalledWith({
      region: "ap-northeast-2",
      tableName: "hot-updater-metadata",
    });
    expect(mocks.s3Storage).toHaveBeenCalledWith(
      expect.objectContaining({
        bucketName: "hot-updater-bundles",
        region: "ap-northeast-2",
        getDownloadUrl: expect.any(Function),
      }),
    );
  });

  it("signs download URLs for the distribution each request came through", async () => {
    const { s3Storage, serveManagedLambda } = await import("./managed");
    const storage = s3Storage() as unknown as {
      config: {
        getDownloadUrl: (input: {
          storageUri: string;
        }) => Promise<{ url: string }>;
      };
    };
    const handler = serveManagedLambda({
      handlers: {
        client: async () =>
          Response.json(
            await storage.config.getDownloadUrl({
              storageUri: "s3://hot-updater-bundles/bundles/1/manifest.json",
            }),
          ),
      },
    });

    const [first, second] = await Promise.all([
      handler(event("first.cloudfront.net"), {} as never, () => undefined),
      handler(event("second.cloudfront.net"), {} as never, () => undefined),
    ]);

    expect(bodyOf(first)).toEqual({
      url: "https://first.cloudfront.net/bundles/1/manifest.json",
    });
    expect(bodyOf(second)).toEqual({
      url: "https://second.cloudfront.net/bundles/1/manifest.json",
    });
    await expect(
      storage.config.getDownloadUrl({
        storageUri: "s3://hot-updater-bundles/bundles/1/manifest.json",
      }),
    ).rejects.toThrow(
      "The managed AWS server signs download URLs only while it serves a CloudFront request.",
    );
  });
});
