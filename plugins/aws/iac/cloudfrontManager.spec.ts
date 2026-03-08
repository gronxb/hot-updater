import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDistributionConfig } from "./cloudfrontDistributionConfig";

const mockCloudFront = vi.hoisted(() => ({
  listOriginAccessControls: vi.fn(),
  createOriginAccessControl: vi.fn(),
  listCachePolicies: vi.fn(),
  createCachePolicy: vi.fn(),
  listDistributions: vi.fn(),
  getDistributionConfig: vi.fn(),
  updateDistribution: vi.fn(),
  createInvalidation: vi.fn(),
}));

const mockPrompt = vi.hoisted(() => ({
  log: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  select: vi.fn(),
  isCancel: vi.fn(() => false),
}));

vi.mock("@aws-sdk/client-cloudfront", () => ({
  CloudFront: vi.fn(() => mockCloudFront),
}));

vi.mock("@hot-updater/cli-tools", () => ({
  p: mockPrompt,
}));

import { CloudFrontManager } from "./cloudfront";

describe("CloudFrontManager", () => {
  const existingDistributionConfig = buildDistributionConfig({
    bucketName: "hot-updater-storage",
    bucketDomain: "hot-updater-storage.s3.ap-northeast-2.amazonaws.com",
    functionArn: "arn:aws:lambda:us-east-1:123456789012:function:hot-updater:1",
    keyGroupId: "existing-key-group-id",
    oacId: "existing-oac-id",
    legacyCachePolicyId: "existing-legacy-cache-policy-id",
    sharedCachePolicyId: "existing-shared-cache-policy-id",
  });

  beforeEach(() => {
    vi.clearAllMocks();

    mockCloudFront.listOriginAccessControls.mockResolvedValue({
      OriginAccessControlList: {
        Items: [{ Id: "oac-id", Name: "HotUpdaterOAC" }],
      },
    });
    mockCloudFront.listDistributions.mockResolvedValue({
      DistributionList: {
        Items: [
          {
            Id: "dist-id",
            DomainName: "d111111abcdef8.cloudfront.net",
            Origins: {
              Items: [
                {
                  DomainName:
                    "hot-updater-storage.s3.ap-northeast-2.amazonaws.com",
                },
              ],
            },
          },
        ],
      },
    });
    mockCloudFront.getDistributionConfig.mockResolvedValue({
      ETag: "etag-value",
      DistributionConfig: existingDistributionConfig,
    });
    mockCloudFront.updateDistribution.mockResolvedValue({});
    mockCloudFront.createInvalidation.mockResolvedValue({});
  });

  it("paginates cache policy lookups before attempting creation", async () => {
    mockCloudFront.listCachePolicies
      .mockResolvedValueOnce({
        CachePolicyList: {
          Items: [],
          NextMarker: "legacy-cache-page-2",
        },
      })
      .mockResolvedValueOnce({
        CachePolicyList: {
          Items: [
            {
              CachePolicy: {
                Id: "legacy-cache-policy-id",
                CachePolicyConfig: {
                  Name: "HotUpdaterLegacyCheckUpdateNoCache",
                },
              },
            },
          ],
        },
      });

    mockCloudFront.listCachePolicies
      .mockResolvedValueOnce({
        CachePolicyList: {
          Items: [],
          NextMarker: "shared-cache-page-2",
        },
      })
      .mockResolvedValueOnce({
        CachePolicyList: {
          Items: [
            {
              CachePolicy: {
                Id: "shared-cache-policy-id",
                CachePolicyConfig: {
                  Name: "HotUpdaterOriginCacheControl",
                },
              },
            },
          ],
        },
      });

    const manager = new CloudFrontManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    await manager.createOrUpdateDistribution({
      keyGroupId: "new-key-group-id",
      bucketName: "hot-updater-storage",
      functionArn:
        "arn:aws:lambda:us-east-1:123456789012:function:hot-updater:2",
    });

    expect(mockCloudFront.listCachePolicies).toHaveBeenNthCalledWith(1, {
      Type: "custom",
    });
    expect(mockCloudFront.listCachePolicies).toHaveBeenNthCalledWith(2, {
      Type: "custom",
      Marker: "legacy-cache-page-2",
    });
    expect(mockCloudFront.listCachePolicies).toHaveBeenNthCalledWith(3, {
      Type: "custom",
    });
    expect(mockCloudFront.listCachePolicies).toHaveBeenNthCalledWith(4, {
      Type: "custom",
      Marker: "shared-cache-page-2",
    });
    expect(mockCloudFront.createCachePolicy).not.toHaveBeenCalled();

    expect(mockCloudFront.updateDistribution).toHaveBeenCalledWith(
      expect.objectContaining({
        Id: "dist-id",
        IfMatch: "etag-value",
        DistributionConfig: expect.objectContaining({
          DefaultCacheBehavior: expect.objectContaining({
            CachePolicyId: "shared-cache-policy-id",
          }),
          CacheBehaviors: expect.objectContaining({
            Items: expect.arrayContaining([
              expect.objectContaining({
                PathPattern: "/api/check-update",
                CachePolicyId: "legacy-cache-policy-id",
                LambdaFunctionAssociations: expect.objectContaining({
                  Items: expect.arrayContaining([
                    expect.objectContaining({
                      EventType: "origin-request",
                    }),
                  ]),
                }),
              }),
              expect.objectContaining({
                PathPattern: "/api/check-update/*",
                CachePolicyId: "shared-cache-policy-id",
                LambdaFunctionAssociations: expect.objectContaining({
                  Items: expect.arrayContaining([
                    expect.objectContaining({
                      EventType: "origin-request",
                    }),
                  ]),
                }),
              }),
            ]),
          }),
        }),
      }),
    );
  });
});
