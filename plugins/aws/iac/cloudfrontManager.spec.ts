import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDistributionConfig } from "./cloudfrontDistributionConfig";

const mockCloudFront = vi.hoisted(() => ({
  listOriginAccessControls: vi.fn(),
  createOriginAccessControl: vi.fn(),
  listOriginRequestPolicies: vi.fn(),
  createOriginRequestPolicy: vi.fn(),
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
    originRequestPolicyId: "existing-origin-request-policy-id",
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

  it("paginates origin request and cache policy lookups before attempting creation", async () => {
    mockCloudFront.listOriginRequestPolicies
      .mockResolvedValueOnce({
        OriginRequestPolicyList: {
          Items: [],
          NextMarker: "origin-page-2",
        },
      })
      .mockResolvedValueOnce({
        OriginRequestPolicyList: {
          Items: [
            {
              OriginRequestPolicy: {
                Id: "origin-policy-id",
                OriginRequestPolicyConfig: {
                  Name: "HotUpdaterCheckUpdateOriginRequestPolicy",
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
          NextMarker: "cache-page-2",
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

    expect(mockCloudFront.listOriginRequestPolicies).toHaveBeenNthCalledWith(
      1,
      {
        Type: "custom",
      },
    );
    expect(mockCloudFront.listOriginRequestPolicies).toHaveBeenNthCalledWith(
      2,
      {
        Type: "custom",
        Marker: "origin-page-2",
      },
    );
    expect(mockCloudFront.createOriginRequestPolicy).not.toHaveBeenCalled();

    expect(mockCloudFront.listCachePolicies).toHaveBeenNthCalledWith(1, {
      Type: "custom",
    });
    expect(mockCloudFront.listCachePolicies).toHaveBeenNthCalledWith(2, {
      Type: "custom",
      Marker: "cache-page-2",
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
                OriginRequestPolicyId: "origin-policy-id",
              }),
              expect.objectContaining({
                PathPattern: "/api/check-update/*",
                CachePolicyId: "shared-cache-policy-id",
              }),
            ]),
          }),
        }),
      }),
    );
  });
});
