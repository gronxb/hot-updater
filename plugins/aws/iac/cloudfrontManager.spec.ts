import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildDistributionConfig,
  HOT_UPDATER_API_CACHE_POLICY_CONFIG,
  HOT_UPDATER_SHARED_CACHE_POLICY_CONFIG,
} from "./cloudfrontDistributionConfig";

const mockCloudFront = vi.hoisted(() => ({
  listOriginAccessControls: vi.fn(),
  createOriginAccessControl: vi.fn(),
  listCachePolicies: vi.fn(),
  getCachePolicy: vi.fn(),
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
  CloudFront: vi.fn(function CloudFront() {
    return mockCloudFront;
  }),
}));

vi.mock("@hot-updater/cli-tools", () => ({
  p: mockPrompt,
}));

import { CloudFrontManager } from "./cloudfront";

describe("CloudFrontManager", () => {
  const existingDistributionConfig = buildDistributionConfig({
    apiCachePolicyId: "existing-api-cache-policy-id",
    bucketName: "hot-updater-storage",
    bucketDomain: "hot-updater-storage.s3.ap-northeast-2.amazonaws.com",
    functionArn: "arn:aws:lambda:us-east-1:123456789012:function:hot-updater:1",
    keyGroupId: "existing-key-group-id",
    oacId: "existing-oac-id",
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
    mockCloudFront.listCachePolicies.mockResolvedValue({
      CachePolicyList: {
        Items: [
          {
            CachePolicy: {
              Id: "api-cache-policy-id",
              CachePolicyConfig: {
                Name: "HotUpdaterAuthenticatedNoCache",
              },
            },
          },
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
    mockCloudFront.getCachePolicy.mockImplementation(
      ({ Id }: { Id: string }) => {
        const CachePolicyConfig =
          Id === "api-cache-policy-id"
            ? HOT_UPDATER_API_CACHE_POLICY_CONFIG
            : HOT_UPDATER_SHARED_CACHE_POLICY_CONFIG;
        return Promise.resolve({
          CachePolicy: {
            CachePolicyConfig,
            Id,
          },
        });
      },
    );
  });

  it("reuses separate API and bundle cache policies before updating", async () => {
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
    });
    expect(mockCloudFront.createCachePolicy).not.toHaveBeenCalled();
    expect(mockCloudFront.getCachePolicy).toHaveBeenCalledWith({
      Id: "api-cache-policy-id",
    });
    expect(mockCloudFront.getCachePolicy).toHaveBeenCalledWith({
      Id: "shared-cache-policy-id",
    });

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
                PathPattern: "/api/check-update/*",
                CachePolicyId: "api-cache-policy-id",
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
    expect(mockCloudFront.createInvalidation).toHaveBeenCalledWith({
      DistributionId: "dist-id",
      InvalidationBatch: expect.objectContaining({
        Paths: {
          Quantity: 1,
          Items: ["/api/check-update/*"],
        },
      }),
    });
  });

  it("fails closed when an existing cache policy has drifted", async () => {
    const manager = new CloudFrontManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });
    mockCloudFront.getCachePolicy.mockResolvedValue({
      CachePolicy: {
        Id: "api-cache-policy-id",
        CachePolicyConfig: {
          ...HOT_UPDATER_API_CACHE_POLICY_CONFIG,
          MinTTL: 60,
        },
      },
    });

    await expect(
      manager.createOrUpdateDistribution({
        keyGroupId: "new-key-group-id",
        bucketName: "hot-updater-storage",
        functionArn:
          "arn:aws:lambda:us-east-1:123456789012:function:hot-updater:2",
      }),
    ).rejects.toThrow(
      "does not match the required Hot Updater security configuration",
    );
    expect(mockCloudFront.createCachePolicy).not.toHaveBeenCalled();
    expect(mockCloudFront.updateDistribution).not.toHaveBeenCalled();
  });
});
