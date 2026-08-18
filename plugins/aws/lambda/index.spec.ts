import type { CloudFrontRequest, CloudFrontRequestEvent } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DISTRIBUTION_HOST = "d111111abcdef8.cloudfront.net";
const ORIGIN_HOST = "hot-updater-test.s3.us-east-1.amazonaws.com";

const databaseMocks = vi.hoisted(() => ({
  dynamoDB: vi.fn(() => ({ name: "dynamoDB" })),
}));
const serverMocks = vi.hoisted(() => ({ createHotUpdater: vi.fn() }));

const fakeHotUpdaterHandler = vi.fn(
  async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
);

vi.mock("../src/dynamoDB", () => ({
  dynamoDB: databaseMocks.dynamoDB,
}));

vi.mock("../src/s3Storage", () => ({
  s3Storage: vi.fn(() => ({ name: "mockStorage", protocol: "s3" })),
}));

vi.mock("../src/cloudFrontDownloadUrl", () => ({
  cloudFrontDownloadUrl: vi.fn(() => vi.fn()),
}));

vi.mock("@hot-updater/server", async () => {
  const actual = await vi.importActual<typeof import("@hot-updater/server")>(
    "@hot-updater/server",
  );

  return {
    ...actual,
    createHotUpdater: serverMocks.createHotUpdater.mockReturnValue({
      basePath: "/",
      handler: fakeHotUpdaterHandler,
    }),
  };
});

const createCloudFrontRequest = (uri: string): CloudFrontRequestEvent => ({
  Records: [
    {
      cf: {
        config: {
          distributionDomainName: DISTRIBUTION_HOST,
          distributionId: "dist-id",
          eventType: "origin-request",
          requestId: "request-id",
        },
        request: {
          clientIp: "127.0.0.1",
          headers: {
            host: [
              {
                key: "host",
                value: ORIGIN_HOST,
              },
            ],
          },
          method: "GET",
          origin: {
            custom: {
              customHeaders: {},
              domainName: ORIGIN_HOST,
              keepaliveTimeout: 5,
              path: "",
              port: 443,
              protocol: "https",
              readTimeout: 30,
              sslProtocols: ["TLSv1.2"],
            },
          },
          querystring: "",
          uri,
        } satisfies CloudFrontRequest,
      },
    },
  ],
});

const parseResponseBody = (
  body:
    | string
    | {
        data: string;
        encoding: "base64" | "text";
      }
    | undefined,
) => {
  if (!body) {
    return null;
  }

  if (typeof body === "string") {
    return JSON.parse(body);
  }

  const responseBody =
    body.encoding === "base64"
      ? Buffer.from(body.data, "base64").toString("utf8")
      : body.data;

  return JSON.parse(responseBody);
};

describe("aws lambda entrypoint", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    globalThis.HotUpdater = {
      AUTHORITY_ID: "aws.test-authority",
      CLOUDFRONT_KEY_PAIR_ID: "KTEST",
      DYNAMODB_REGION: "us-east-1",
      DYNAMODB_TABLE_NAME: "hot-updater-metadata",
      SSM_PARAMETER_NAME: "/hot-updater/test",
      SSM_REGION: "us-east-1",
      S3_BUCKET_NAME: "hot-updater-test",
    };
  });

  it("uses DynamoDB metadata with built-in Analytics and client keys", async () => {
    const { handler } = await import("./index");
    await handler(
      createCloudFrontRequest(
        "/v2/release-catalogs/app-version/aws.test-authority/ios/cHJvZHVjdGlvbg/1.0.0",
      ),
      {} as never,
      () => undefined,
    );

    expect(databaseMocks.dynamoDB).toHaveBeenCalledWith({
      region: "us-east-1",
      tableName: "hot-updater-metadata",
    });
    expect(serverMocks.createHotUpdater).toHaveBeenCalledWith(
      expect.objectContaining({
        authorityId: "aws.test-authority",
        features: {
          updateCheck: true,
          bundles: false,
          analytics: {},
          clientAccessKeys: true,
        },
      }),
    );
  });

  it("serves v1 Release Catalog routes for origin-request events", async () => {
    const { handler } = await import("./index");

    const response = await handler(
      createCloudFrontRequest(
        "/v2/release-catalogs/app-version/aws.test-authority/ios/cHJvZHVjdGlvbg/1.0.0",
      ),
      {} as never,
      () => undefined,
    );

    expect(fakeHotUpdaterHandler).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      status: "200",
    });
    expect(parseResponseBody(response?.body)).toEqual({ ok: true });
  });
});
