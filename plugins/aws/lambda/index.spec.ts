import type { CloudFrontRequest, CloudFrontRequestEvent } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DISTRIBUTION_HOST = "d111111abcdef8.cloudfront.net";
const ORIGIN_HOST = "hot-updater-test.s3.us-east-1.amazonaws.com";

const fakeHotUpdaterHandler = vi.fn(
  async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
);

vi.mock("../src/s3Database", () => ({
  s3Database: vi.fn(() => ({ name: "mockDatabase" })),
}));

vi.mock("../src/s3Storage", () => ({
  s3Storage: vi.fn(() => () => ({ name: "mockStorage" })),
}));

vi.mock("../src/withCloudFrontSignedUrl", () => ({
  withCloudFrontSignedUrl: vi.fn(
    (storageFactory: () => unknown) => storageFactory,
  ),
}));

vi.mock("@hot-updater/server/runtime", async () => {
  const actual = await vi.importActual<
    typeof import("@hot-updater/server/runtime")
  >("@hot-updater/server/runtime");

  return {
    ...actual,
    createHotUpdater: vi.fn(() => ({
      basePath: "/api/check-update",
      handler: fakeHotUpdaterHandler,
    })),
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

describe("aws lambda entrypoint", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    globalThis.HotUpdater = {
      CLOUDFRONT_KEY_PAIR_ID: "KTEST",
      SSM_PARAMETER_NAME: "/hot-updater/test",
      SSM_REGION: "us-east-1",
      S3_BUCKET_NAME: "hot-updater-test",
    };
  });

  it("serves canonical app-version routes without a cohort segment for origin-request events", async () => {
    const { handler, SHARED_EDGE_CACHE_CONTROL } = await import("./index");

    const response = await handler(
      createCloudFrontRequest(
        "/api/check-update/app-version/ios/1.0/production/default/default",
      ),
      {} as never,
      () => undefined,
    );

    expect(fakeHotUpdaterHandler).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      status: "200",
    });
    expect(response?.headers?.["cache-control"]?.[0]?.value).toBe(
      SHARED_EDGE_CACHE_CONTROL,
    );
    expect(JSON.parse(response?.body ?? "null")).toEqual({ ok: true });
  });

  it("serves canonical app-version routes with a cohort segment for origin-request events", async () => {
    const { handler, SHARED_EDGE_CACHE_CONTROL } = await import("./index");

    const response = await handler(
      createCloudFrontRequest(
        "/api/check-update/app-version/ios/1.0/production/default/default/777",
      ),
      {} as never,
      () => undefined,
    );

    expect(fakeHotUpdaterHandler).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      status: "200",
    });
    expect(response?.headers?.["cache-control"]?.[0]?.value).toBe(
      SHARED_EDGE_CACHE_CONTROL,
    );
    expect(JSON.parse(response?.body ?? "null")).toEqual({ ok: true });
  });
});
