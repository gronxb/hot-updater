import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildDistributionConfig,
  MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID,
  MANAGED_CACHING_DISABLED_POLICY_ID,
} from "./cloudfrontDistributionConfig";

const mockCloudFront = vi.hoisted(() => ({
  listOriginAccessControls: vi.fn(),
  createOriginAccessControl: vi.fn(),
  listCachePolicies: vi.fn(),
  getCachePolicy: vi.fn(),
  createCachePolicy: vi.fn(),
  updateCachePolicy: vi.fn(),
  deleteCachePolicy: vi.fn(),
  listOriginRequestPolicies: vi.fn(),
  getOriginRequestPolicy: vi.fn(),
  createOriginRequestPolicy: vi.fn(),
  deleteOriginRequestPolicy: vi.fn(),
  listDistributions: vi.fn(),
  getDistribution: vi.fn(),
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
  const cachePolicies = new Map<string, { Name?: string }>();
  const originRequestPolicies = new Map<string, { Name?: string }>();
  const mockFetch = vi.fn<typeof fetch>();
  const existingDistributionConfig = buildDistributionConfig({
    bucketName: "hot-updater-storage",
    bucketDomain: "hot-updater-storage.s3.ap-northeast-2.amazonaws.com",
    functionArn: "arn:aws:lambda:us-east-1:123456789012:function:hot-updater:1",
    keyGroupId: "existing-key-group-id",
    oacId: "existing-oac-id",
    originRequestPolicyId: "existing-origin-request-policy-id",
    releaseCatalogCachePolicyId: "existing-release-catalog-cache-policy-id",
    sharedCachePolicyId: "existing-shared-cache-policy-id",
  });
  const mockMatchingDistribution = ({
    domainName,
    id,
  }: {
    domainName: string;
    id: string;
  }) => {
    mockCloudFront.listDistributions.mockResolvedValue({
      DistributionList: {
        Items: [
          {
            Id: id,
            DomainName: domainName,
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
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ infrastructureGeneration: 1 }), {
        status: 200,
      }),
    );
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
    // The account's custom policies, which every deployment in it shares.
    cachePolicies.clear();
    originRequestPolicies.clear();
    mockCloudFront.listCachePolicies.mockImplementation(async () => ({
      CachePolicyList: {
        Items: [...cachePolicies].map(([Id, CachePolicyConfig]) => ({
          CachePolicy: { Id, CachePolicyConfig },
        })),
      },
    }));
    mockCloudFront.createCachePolicy.mockImplementation(
      async ({ CachePolicyConfig }) => {
        const Id = `cache-policy-${cachePolicies.size + 1}`;
        cachePolicies.set(Id, CachePolicyConfig);
        return { CachePolicy: { Id } };
      },
    );
    mockCloudFront.listOriginRequestPolicies.mockImplementation(async () => ({
      OriginRequestPolicyList: {
        Items: [...originRequestPolicies].map(
          ([Id, OriginRequestPolicyConfig]) => ({
            OriginRequestPolicy: { Id, OriginRequestPolicyConfig },
          }),
        ),
      },
    }));
    mockCloudFront.createOriginRequestPolicy.mockImplementation(
      async ({ OriginRequestPolicyConfig }) => {
        const Id = `origin-request-policy-${originRequestPolicies.size + 1}`;
        originRequestPolicies.set(Id, OriginRequestPolicyConfig);
        return { OriginRequestPolicy: { Id } };
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates the policies a deployment needs once, and reuses them as they are", async () => {
    const manager = new CloudFrontManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });
    const deploy = () =>
      manager.createOrUpdateDistribution({
        keyGroupId: "new-key-group-id",
        bucketName: "hot-updater-storage",
        clientHeaders: ["x-api-key"],
        functionArn:
          "arn:aws:lambda:us-east-1:123456789012:function:hot-updater:2",
        pluginPaths: ["/events", "/notes/*"],
      });

    await deploy();
    await deploy();

    // The shared and Release catalog cache policies, and the origin request
    // policy: created once, never changed.
    expect(mockCloudFront.createCachePolicy).toHaveBeenCalledTimes(2);
    expect(mockCloudFront.createOriginRequestPolicy).toHaveBeenCalledTimes(1);
    expect(mockCloudFront.updateCachePolicy).not.toHaveBeenCalled();
    expect(mockCloudFront.getCachePolicy).not.toHaveBeenCalled();
    const [sharedId, catalogId] = [...cachePolicies.keys()];
    const [originRequestId] = [...originRequestPolicies.keys()];
    expect(mockCloudFront.updateDistribution).toHaveBeenLastCalledWith(
      expect.objectContaining({
        Id: "dist-id",
        IfMatch: "etag-value",
        DistributionConfig: expect.objectContaining({
          DefaultCacheBehavior: expect.objectContaining({
            CachePolicyId: sharedId,
          }),
          CacheBehaviors: expect.objectContaining({
            Items: expect.arrayContaining([
              expect.objectContaining({
                PathPattern: "/artifacts/*",
                CachePolicyId: sharedId,
                OriginRequestPolicyId: originRequestId,
                LambdaFunctionAssociations: expect.objectContaining({
                  Items: expect.arrayContaining([
                    expect.objectContaining({ EventType: "origin-request" }),
                  ]),
                }),
              }),
              expect.objectContaining({
                PathPattern: "/version",
                CachePolicyId: sharedId,
                OriginRequestPolicyId: originRequestId,
              }),
              expect.objectContaining({
                PathPattern: "/release-catalogs/*",
                CachePolicyId: catalogId,
                OriginRequestPolicyId: originRequestId,
              }),
              // The plugins' endpoints pass through uncached.
              expect.objectContaining({
                PathPattern: "/events",
                CachePolicyId: MANAGED_CACHING_DISABLED_POLICY_ID,
                OriginRequestPolicyId:
                  MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID,
              }),
              expect.objectContaining({
                PathPattern: "/notes/*",
                CachePolicyId: MANAGED_CACHING_DISABLED_POLICY_ID,
                OriginRequestPolicyId:
                  MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID,
              }),
            ]),
          }),
        }),
      }),
    );
    expect(mockCloudFront.createInvalidation).toHaveBeenLastCalledWith({
      DistributionId: "dist-id",
      InvalidationBatch: {
        CallerReference: expect.any(String),
        Paths: {
          Quantity: 5,
          Items: [
            "/artifacts/*",
            "/version",
            "/release-catalogs/*",
            "/events",
            "/notes/*",
          ],
        },
      },
    });
  });

  it("gives a deployment whose server reads other client headers policies of its own, and leaves the other deployment's as they are", async () => {
    const manager = new CloudFrontManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });
    const deploy = (clientHeaders: readonly string[]) =>
      manager.createOrUpdateDistribution({
        keyGroupId: "new-key-group-id",
        bucketName: "hot-updater-storage",
        clientHeaders,
        functionArn:
          "arn:aws:lambda:us-east-1:123456789012:function:hot-updater:2",
      });

    // Production keeps API keys; staging's definition dropped apiKeys().
    await deploy(["x-api-key"]);
    const production = structuredClone([
      ...cachePolicies,
      ...originRequestPolicies,
    ]);
    await deploy([]);
    await deploy(["x-api-key"]);

    expect(cachePolicies.size).toBe(4);
    expect(originRequestPolicies.size).toBe(2);
    expect(
      new Set([...cachePolicies.values()].map(({ Name }) => Name)).size,
    ).toBe(4);
    // Production's policies, and what they forward, never changed.
    for (const [id, config] of production) {
      expect(cachePolicies.get(id) ?? originRequestPolicies.get(id)).toEqual(
        config,
      );
    }
    expect(mockCloudFront.updateCachePolicy).not.toHaveBeenCalled();
    expect(JSON.stringify(production)).toContain("x-api-key");
  });

  it("uses the policies another init created first when both create them at once", async () => {
    const manager = new CloudFrontManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });
    // Another init with the same client headers creates each policy
    // between this init's list and its create.
    mockCloudFront.createCachePolicy.mockImplementation(
      async ({ CachePolicyConfig }) => {
        cachePolicies.set(`other-${cachePolicies.size + 1}`, CachePolicyConfig);
        throw Object.assign(new Error("already exists"), {
          name: "CachePolicyAlreadyExists",
        });
      },
    );
    mockCloudFront.createOriginRequestPolicy.mockImplementation(
      async ({ OriginRequestPolicyConfig }) => {
        originRequestPolicies.set("other-origin", OriginRequestPolicyConfig);
        throw Object.assign(new Error("already exists"), {
          name: "OriginRequestPolicyAlreadyExists",
        });
      },
    );

    await manager.createOrUpdateDistribution({
      keyGroupId: "new-key-group-id",
      bucketName: "hot-updater-storage",
      clientHeaders: ["x-api-key"],
      functionArn:
        "arn:aws:lambda:us-east-1:123456789012:function:hot-updater:2",
    });

    const [sharedId, catalogId] = [...cachePolicies.keys()];
    expect(sharedId).toMatch(/^other-/u);
    expect(mockCloudFront.updateDistribution).toHaveBeenLastCalledWith(
      expect.objectContaining({
        DistributionConfig: expect.objectContaining({
          DefaultCacheBehavior: expect.objectContaining({
            CachePolicyId: sharedId,
          }),
          CacheBehaviors: expect.objectContaining({
            Items: expect.arrayContaining([
              expect.objectContaining({
                PathPattern: "/release-catalogs/*",
                CachePolicyId: catalogId,
                OriginRequestPolicyId: "other-origin",
              }),
            ]),
          }),
        }),
      }),
    );
  });

  it("makes a policy again and retries once when another deployment's init deleted it before the update", async () => {
    const manager = new CloudFrontManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });
    // Between this init's list and its update, another deployment's init
    // deletes the shared cache policy, which it found unused.
    mockCloudFront.updateDistribution.mockImplementationOnce(
      async ({ DistributionConfig }) => {
        cachePolicies.delete(
          DistributionConfig.DefaultCacheBehavior.CachePolicyId,
        );
        throw Object.assign(new Error("gone"), { name: "NoSuchCachePolicy" });
      },
    );

    await manager.createOrUpdateDistribution({
      keyGroupId: "new-key-group-id",
      bucketName: "hot-updater-storage",
      clientHeaders: ["x-api-key"],
      functionArn:
        "arn:aws:lambda:us-east-1:123456789012:function:hot-updater:2",
    });

    expect(mockCloudFront.createCachePolicy).toHaveBeenCalledTimes(3);
    expect(mockCloudFront.getDistributionConfig).toHaveBeenCalledTimes(2);
    expect(mockCloudFront.updateDistribution).toHaveBeenCalledTimes(2);
    const [first, second] = mockCloudFront.updateDistribution.mock.calls.map(
      ([input]) => input.DistributionConfig.DefaultCacheBehavior.CachePolicyId,
    );
    expect(second).not.toBe(first);
    expect(cachePolicies.has(second)).toBe(true);
  });

  it("deletes Hot Updater's policies no distribution uses, and keeps those in use, just made, or not its own", async () => {
    const manager = new CloudFrontManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });
    const old = new Date("2026-09-01T00:00:00Z");
    const policy = (Name: string, LastModifiedTime: Date) => ({
      config: { Name },
      LastModifiedTime,
    });
    // The account's policies: rc.20's, which this distribution uses before
    // the update, one another distribution uses, a retired one, one another
    // init just made, and one that isn't Hot Updater's.
    const accountCachePolicies = new Map([
      [
        "existing-shared-cache-policy-id",
        policy("HotUpdaterOriginCacheControlV2", old),
      ],
      [
        "existing-release-catalog-cache-policy-id",
        policy("HotUpdaterReleaseCatalogV1", old),
      ],
      ["other-cache-policy", policy("HotUpdaterOriginCacheControlV2-a", old)],
      ["retired-cache-policy", policy("HotUpdaterReleaseCatalogV1-b", old)],
      [
        "recent-cache-policy",
        policy("HotUpdaterReleaseCatalogV1-c", new Date()),
      ],
      ["user-cache-policy", policy("MyCachePolicy", old)],
    ]);
    const accountOriginRequestPolicies = new Map([
      [
        "existing-origin-request-policy-id",
        policy("HotUpdaterManagedApiOriginRequestV2", old),
      ],
    ]);
    const distributions = new Map<string, unknown>([
      ["dist-id", existingDistributionConfig],
      [
        "other-dist-id",
        { DefaultCacheBehavior: { CachePolicyId: "other-cache-policy" } },
      ],
    ]);
    const inUse = (id: string) =>
      [...distributions.values()].some((config) =>
        JSON.stringify(config).includes(`"${id}"`),
      );
    mockCloudFront.listCachePolicies.mockImplementation(async () => ({
      CachePolicyList: {
        Items: [...accountCachePolicies].map(
          ([Id, { config, LastModifiedTime }]) => ({
            CachePolicy: { Id, LastModifiedTime, CachePolicyConfig: config },
          }),
        ),
      },
    }));
    mockCloudFront.createCachePolicy.mockImplementation(
      async ({ CachePolicyConfig }) => {
        const Id = `new-cache-policy-${accountCachePolicies.size}`;
        accountCachePolicies.set(Id, {
          config: CachePolicyConfig,
          LastModifiedTime: new Date(),
        });
        return { CachePolicy: { Id } };
      },
    );
    mockCloudFront.listOriginRequestPolicies.mockImplementation(async () => ({
      OriginRequestPolicyList: {
        Items: [...accountOriginRequestPolicies].map(
          ([Id, { config, LastModifiedTime }]) => ({
            OriginRequestPolicy: {
              Id,
              LastModifiedTime,
              OriginRequestPolicyConfig: config,
            },
          }),
        ),
      },
    }));
    mockCloudFront.createOriginRequestPolicy.mockImplementation(
      async ({ OriginRequestPolicyConfig }) => {
        const Id = "new-origin-request-policy";
        accountOriginRequestPolicies.set(Id, {
          config: OriginRequestPolicyConfig,
          LastModifiedTime: new Date(),
        });
        return { OriginRequestPolicy: { Id } };
      },
    );
    mockCloudFront.updateDistribution.mockImplementation(
      async ({ Id, DistributionConfig }) => {
        distributions.set(Id, DistributionConfig);
        return {};
      },
    );
    mockCloudFront.getCachePolicy.mockImplementation(async ({ Id }) => ({
      ETag: `etag-${Id}`,
    }));
    mockCloudFront.getOriginRequestPolicy.mockImplementation(
      async ({ Id }) => ({
        ETag: `etag-${Id}`,
      }),
    );
    // CloudFront refuses to delete a policy a distribution uses.
    mockCloudFront.deleteCachePolicy.mockImplementation(async ({ Id }) => {
      if (inUse(Id)) {
        throw Object.assign(new Error("in use"), { name: "CachePolicyInUse" });
      }
      accountCachePolicies.delete(Id);
      return {};
    });
    mockCloudFront.deleteOriginRequestPolicy.mockImplementation(
      async ({ Id }) => {
        if (inUse(Id)) {
          throw Object.assign(new Error("in use"), {
            name: "OriginRequestPolicyInUse",
          });
        }
        accountOriginRequestPolicies.delete(Id);
        return {};
      },
    );

    await manager.createOrUpdateDistribution({
      keyGroupId: "new-key-group-id",
      bucketName: "hot-updater-storage",
      clientHeaders: ["x-api-key"],
      functionArn:
        "arn:aws:lambda:us-east-1:123456789012:function:hot-updater:2",
    });

    expect([...accountCachePolicies.keys()].sort()).toEqual(
      [
        "new-cache-policy-6",
        "new-cache-policy-7",
        "other-cache-policy",
        "recent-cache-policy",
        "user-cache-policy",
      ].sort(),
    );
    expect([...accountOriginRequestPolicies.keys()]).toEqual([
      "new-origin-request-policy",
    ]);
    expect(mockCloudFront.deleteCachePolicy).toHaveBeenCalledWith({
      Id: "retired-cache-policy",
      IfMatch: "etag-retired-cache-policy",
    });
    // Another distribution's policy was tried, and CloudFront kept it.
    expect(mockCloudFront.deleteCachePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ Id: "other-cache-policy" }),
    );
    expect(mockPrompt.log.warn).not.toHaveBeenCalled();
  });

  it("reads whether the distribution deployed, and the function versions its behaviors run", async () => {
    const manager = new CloudFrontManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });
    const association = (arn: string) => ({
      LambdaFunctionAssociations: {
        Items: [{ EventType: "origin-request", LambdaFunctionARN: arn }],
      },
    });
    mockCloudFront.getDistribution.mockResolvedValueOnce({
      Distribution: {
        Status: "InProgress",
        DistributionConfig: {
          DefaultCacheBehavior: association(
            "arn:aws:lambda:us-east-1:123456789012:function:hot-updater-edge:3",
          ),
          CacheBehaviors: {
            Items: [
              association(
                "arn:aws:lambda:us-east-1:123456789012:function:hot-updater-edge:3",
              ),
              association(
                "arn:aws:lambda:us-east-1:123456789012:function:hot-updater-edge:2",
              ),
              association(
                "arn:aws:lambda:us-east-1:123456789012:function:someone-else:9",
              ),
              {},
            ],
          },
        },
      },
    });

    await expect(
      manager.edgeDeploymentOf("dist-id", "hot-updater-edge"),
    ).resolves.toEqual({ deployed: false, versions: ["3", "2"] });

    mockCloudFront.getDistribution.mockRejectedValueOnce(
      Object.assign(new Error("gone"), { name: "NoSuchDistribution" }),
    );
    await expect(
      manager.edgeDeploymentOf("dist-id", "hot-updater-edge"),
    ).resolves.toBeUndefined();
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
        clientHeaders: ["x-api-key"],
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

  it.each([1, 2])(
    "creates a new distribution instead of inferring one of %i same-bucket distributions",
    async (distributionCount) => {
      // Given
      mockCloudFront.listDistributions.mockResolvedValue({
        DistributionList: {
          Items: Array.from({ length: distributionCount }, (_, index) => ({
            Id: `existing-${index}-dist-id`,
            DomainName: `existing-${index}.cloudfront.net`,
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

      // When / Then
      await expect(
        manager.selectDistribution({
          bucketName: "hot-updater-storage",
          nonInteractive: true,
        }),
      ).resolves.toBeNull();
      expect(mockPrompt.select).not.toHaveBeenCalled();
    },
  );

  it("offers a new distribution first when the saved distribution is missing", async () => {
    mockMatchingDistribution({
      domainName: "legacy.cloudfront.net",
      id: "legacy-dist-id",
    });
    mockPrompt.select.mockImplementationOnce(
      async ({ initialValue }) => initialValue,
    );
    const manager = new CloudFrontManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    await expect(
      manager.selectDistribution({
        bucketName: "hot-updater-storage",
        distributionId: "deleted-dist-id",
        nonInteractive: false,
      }),
    ).resolves.toBeNull();
    const prompt = mockPrompt.select.mock.calls[0]?.[0];
    expect(prompt.options[0]).toEqual({
      value: "__create-new-cloudfront-distribution__",
      label: "Create New CloudFront Distribution",
    });
    expect(prompt.initialValue).toBe(prompt.options[0].value);
    expect(mockPrompt.log.warn).toHaveBeenCalledWith(
      "Saved CloudFront distribution was not found. A new distribution will be created unless another distribution is selected.",
    );
  });

  it("labels and disables a v0 distribution that uses the selected bucket", async () => {
    mockMatchingDistribution({
      domainName: "legacy.cloudfront.net",
      id: "legacy-dist-id",
    });
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ version: "0.36.0" }), { status: 200 }),
    );
    mockPrompt.select.mockImplementationOnce(
      async ({ initialValue }) => initialValue,
    );
    const manager = new CloudFrontManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    await expect(
      manager.selectDistribution({
        bucketName: "hot-updater-storage",
        distributionId: "legacy-dist-id",
        nonInteractive: false,
      }),
    ).resolves.toBeNull();
    const prompt = mockPrompt.select.mock.calls[0]?.[0];
    expect(prompt.initialValue).toBe("__create-new-cloudfront-distribution__");
    expect(prompt.options[1]).toEqual({
      value: "legacy-dist-id",
      label: "legacy-dist-id (legacy.cloudfront.net) (v0, deprecated)",
      disabled: true,
    });
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "https://legacy.cloudfront.net/version",
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "https://legacy.cloudfront.net/api/check-update/version",
    );
  });

  it("keeps a distribution selectable when its generation cannot be verified", async () => {
    mockMatchingDistribution({
      domainName: "unverified.cloudfront.net",
      id: "unverified-dist-id",
    });
    mockFetch.mockRejectedValue(new Error("network unavailable"));
    mockPrompt.select.mockResolvedValueOnce("unverified-dist-id");
    const manager = new CloudFrontManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    await expect(
      manager.selectDistribution({
        bucketName: "hot-updater-storage",
        nonInteractive: false,
      }),
    ).resolves.toEqual({
      Id: "unverified-dist-id",
      DomainName: "unverified.cloudfront.net",
    });
    expect(mockPrompt.select.mock.calls[0]?.[0].options[1]).toEqual({
      value: "unverified-dist-id",
      label: "unverified-dist-id (unverified.cloudfront.net)",
      disabled: false,
    });
  });

  it("recreates a deleted saved distribution without inferring another same-bucket distribution", async () => {
    mockCloudFront.listDistributions.mockResolvedValue({
      DistributionList: {
        Items: [
          {
            Id: "legacy-dist-id",
            DomainName: "legacy.cloudfront.net",
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
        distributionId: "deleted-dist-id",
        nonInteractive: true,
      }),
    ).resolves.toBeNull();
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
