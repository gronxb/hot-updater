import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildDistributionConfig } from "./cloudfrontDistributionConfig";

const mockCloudFront = vi.hoisted(() => ({
  listOriginAccessControls: vi.fn(),
  createOriginAccessControl: vi.fn(),
  listCachePolicies: vi.fn(),
  getCachePolicy: vi.fn(),
  createCachePolicy: vi.fn(),
  updateCachePolicy: vi.fn(),
  listOriginRequestPolicies: vi.fn(),
  createOriginRequestPolicy: vi.fn(),
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

const mockMakeEnv = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-cloudfront", () => ({
  CloudFront: vi.fn(function CloudFront() {
    return mockCloudFront;
  }),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    makeEnv: mockMakeEnv,
    p: mockPrompt,
  };
});

import { CloudFrontManager } from "./cloudfront";

describe("CloudFrontManager", () => {
  const existingDistributionConfig = buildDistributionConfig({
    bucketName: "hot-updater-storage",
    bucketDomain: "hot-updater-storage.s3.ap-northeast-2.amazonaws.com",
    functionArn: "arn:aws:lambda:us-east-1:123456789012:function:hot-updater:1",
    keyGroupId: "existing-key-group-id",
    oacId: "existing-oac-id",
    originRequestPolicyId: "existing-origin-request-policy-id",
    sharedCachePolicyId: "existing-shared-cache-policy-id",
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrompt.select.mockResolvedValue("dist-id");

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
    mockCloudFront.getCachePolicy.mockResolvedValue({
      ETag: "cache-policy-etag",
    });
    mockCloudFront.updateCachePolicy.mockResolvedValue({});
    mockCloudFront.listOriginRequestPolicies.mockResolvedValue({
      OriginRequestPolicyList: {
        Items: [
          {
            OriginRequestPolicy: {
              Id: "origin-request-policy-id",
              OriginRequestPolicyConfig: {
                Name: "HotUpdaterAnalyticsOriginRequestV2",
              },
            },
          },
        ],
      },
    });
  });

  it("paginates and updates an existing cache policy before reuse", async () => {
    mockCloudFront.listCachePolicies.mockResolvedValueOnce({
      CachePolicyList: {
        Items: [
          {
            CachePolicy: {
              Id: "shared-cache-policy-id",
              CachePolicyConfig: {
                Name: "HotUpdaterOriginCacheControlV2",
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
    expect(mockCloudFront.createCachePolicy).not.toHaveBeenCalled();
    expect(mockCloudFront.getCachePolicy).toHaveBeenCalledWith({
      Id: "shared-cache-policy-id",
    });
    expect(mockCloudFront.updateCachePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        Id: "shared-cache-policy-id",
        IfMatch: "cache-policy-etag",
        CachePolicyConfig: expect.objectContaining({
          ParametersInCacheKeyAndForwardedToOrigin: expect.objectContaining({
            HeadersConfig: {
              HeaderBehavior: "whitelist",
              Headers: {
                Quantity: 2,
                Items: ["hot-updater-sdk-version", "x-api-key"],
              },
            },
          }),
        }),
      }),
    );

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
                CachePolicyId: "shared-cache-policy-id",
                OriginRequestPolicyId: "origin-request-policy-id",
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
      InvalidationBatch: {
        CallerReference: expect.any(String),
        Paths: { Quantity: 1, Items: ["/api/check-update/*"] },
      },
    });
  });

  it("persists a selected distribution before updating it", async () => {
    mockCloudFront.listCachePolicies.mockResolvedValue({
      CachePolicyList: {
        Items: [
          {
            CachePolicy: {
              Id: "shared-cache-policy-id",
              CachePolicyConfig: {
                Name: "HotUpdaterOriginCacheControlV2",
              },
            },
          },
        ],
      },
    });
    mockCloudFront.listDistributions.mockResolvedValue({
      DistributionList: {
        Items: [
          {
            Id: "first-dist-id",
            DomainName: "first.cloudfront.net",
            Origins: {
              Items: [
                {
                  DomainName:
                    "hot-updater-storage.s3.ap-northeast-2.amazonaws.com",
                },
              ],
            },
          },
          {
            Id: "selected-dist-id",
            DomainName: "selected.cloudfront.net",
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
    mockPrompt.select.mockResolvedValue("selected-dist-id");
    mockCloudFront.getDistributionConfig.mockRejectedValue(
      new Error("update failed"),
    );

    const manager = new CloudFrontManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    await expect(
      manager.createOrUpdateDistribution({
        keyGroupId: "new-key-group-id",
        bucketName: "hot-updater-storage",
        functionArn:
          "arn:aws:lambda:us-east-1:123456789012:function:hot-updater:2",
      }),
    ).rejects.toThrow("update failed");

    expect(mockMakeEnv).toHaveBeenCalledWith({
      HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID: "selected-dist-id",
    });
    expect(mockMakeEnv.mock.invocationCallOrder[0]).toBeLessThan(
      mockCloudFront.getDistributionConfig.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("does not prompt for an ambiguous distribution in non-interactive mode", async () => {
    // Given
    mockCloudFront.listCachePolicies.mockResolvedValue({
      CachePolicyList: {
        Items: [
          {
            CachePolicy: {
              Id: "shared-cache-policy-id",
              CachePolicyConfig: {
                Name: "HotUpdaterOriginCacheControlV2",
              },
            },
          },
        ],
      },
    });
    mockCloudFront.listDistributions.mockResolvedValue({
      DistributionList: {
        Items: ["first", "second"].map((id) => ({
          Id: `${id}-dist-id`,
          DomainName: `${id}.cloudfront.net`,
          Origins: {
            Items: [
              {
                DomainName:
                  "hot-updater-storage.s3.ap-northeast-2.amazonaws.com",
              },
            ],
          },
        })),
      },
    });
    const manager = new CloudFrontManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    // When
    const updateDistribution = manager.createOrUpdateDistribution({
      bucketName: "hot-updater-storage",
      functionArn:
        "arn:aws:lambda:us-east-1:123456789012:function:hot-updater:2",
      keyGroupId: "new-key-group-id",
      nonInteractive: true,
    });

    // Then
    await expect(updateDistribution).rejects.toMatchObject({
      missingInputs: ["HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID"],
    });
    expect(mockPrompt.select).not.toHaveBeenCalled();
  });

  it("rejects a missing saved distribution before mutating CloudFront", async () => {
    const manager = new CloudFrontManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    await expect(
      manager.createOrUpdateDistribution({
        bucketName: "hot-updater-storage",
        distributionId: "deleted-dist-id",
        functionArn:
          "arn:aws:lambda:us-east-1:123456789012:function:hot-updater:2",
        keyGroupId: "new-key-group-id",
        nonInteractive: true,
      }),
    ).rejects.toMatchObject({
      missingInputs: ["HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID"],
    });
    expect(mockCloudFront.listOriginAccessControls).not.toHaveBeenCalled();
    expect(mockCloudFront.listCachePolicies).not.toHaveBeenCalled();
    expect(mockCloudFront.updateDistribution).not.toHaveBeenCalled();
    expect(mockPrompt.select).not.toHaveBeenCalled();
  });

  it("recreates a deleted saved distribution when no replacement exists", async () => {
    mockCloudFront.listDistributions.mockResolvedValue({
      DistributionList: { Items: [] },
    });
    const manager = new CloudFrontManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    await expect(
      manager.selectDistribution({
        bucketName: "hot-updater-storage",
        distributionId: "deleted-dist-id",
        nonInteractive: true,
      }),
    ).resolves.toBeNull();
    expect(mockPrompt.select).not.toHaveBeenCalled();
  });

  it("rejects a saved distribution attached to another bucket during env-file replay", async () => {
    // Given
    mockCloudFront.listDistributions.mockResolvedValue({
      DistributionList: {
        Items: [
          {
            Id: "saved-dist-id",
            DomainName: "saved.cloudfront.net",
            Origins: {
              Items: [
                {
                  DomainName: "old-storage.s3.ap-northeast-2.amazonaws.com",
                },
              ],
            },
          },
        ],
      },
    });
    const manager = new CloudFrontManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    // When
    const selection = manager.selectDistribution({
      bucketName: "new-storage",
      distributionId: "saved-dist-id",
      nonInteractive: true,
    });

    // Then
    await expect(selection).rejects.toMatchObject({
      missingInputs: ["HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID"],
    });
    expect(mockPrompt.select).not.toHaveBeenCalled();
  });

  it("finds a saved distribution on a later page", async () => {
    mockCloudFront.listDistributions
      .mockResolvedValueOnce({
        DistributionList: {
          Items: [],
          NextMarker: "next-page",
        },
      })
      .mockResolvedValueOnce({
        DistributionList: {
          Items: [
            {
              Id: "saved-dist-id",
              DomainName: "saved.cloudfront.net",
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
    const manager = new CloudFrontManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    await expect(
      manager.selectDistribution({
        bucketName: "hot-updater-storage",
        distributionId: "saved-dist-id",
        nonInteractive: true,
      }),
    ).resolves.toEqual({
      Id: "saved-dist-id",
      DomainName: "saved.cloudfront.net",
    });
    expect(mockCloudFront.listDistributions).toHaveBeenNthCalledWith(1, {});
    expect(mockCloudFront.listDistributions).toHaveBeenNthCalledWith(2, {
      Marker: "next-page",
    });
    expect(mockPrompt.select).not.toHaveBeenCalled();
  });

  it("prompts with a saved distribution selected by default in interactive mode", async () => {
    // Given
    mockCloudFront.listDistributions.mockResolvedValue({
      DistributionList: {
        Items: [
          {
            Id: "saved-dist-id",
            DomainName: "saved.cloudfront.net",
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
    mockPrompt.select.mockResolvedValue("saved-dist-id");
    const manager = new CloudFrontManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    // When
    await manager.selectDistribution({
      bucketName: "hot-updater-storage",
      distributionId: "saved-dist-id",
      nonInteractive: false,
    });

    // Then
    expect(mockPrompt.select).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "saved-dist-id",
      }),
    );
  });
});
