import { CloudFront } from "@aws-sdk/client-cloudfront";
import { p } from "@hot-updater/cli-tools";
import crypto from "crypto";
import { delay } from "es-toolkit";
import {
  applyDistributionConfigOverrides,
  buildDistributionConfig,
  buildDistributionConfigOverrides,
  HOT_UPDATER_LEGACY_CHECK_UPDATE_CACHE_POLICY_CONFIG,
  HOT_UPDATER_SHARED_CACHE_POLICY_CONFIG,
} from "./cloudfrontDistributionConfig";
import { findInPaginatedCloudFrontList } from "./cloudfrontPagination";
import type { AwsRegion } from "./regionLocationMap";

export class CloudFrontManager {
  private region: AwsRegion;
  private credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };

  constructor(
    region: AwsRegion,
    credentials: {
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    },
  ) {
    this.region = region;
    this.credentials = credentials;
  }

  private async getOrCreateSharedCachePolicy(
    cloudfrontClient: CloudFront,
  ): Promise<string> {
    const existingPolicy = await findInPaginatedCloudFrontList({
      listPage: async (marker) => {
        const listPoliciesResponse = await cloudfrontClient.listCachePolicies({
          Type: "custom",
          ...(marker ? { Marker: marker } : {}),
        });

        return {
          items: listPoliciesResponse.CachePolicyList?.Items ?? [],
          nextMarker: listPoliciesResponse.CachePolicyList?.NextMarker,
        };
      },
      matches: (policy) =>
        policy.CachePolicy?.CachePolicyConfig?.Name ===
        HOT_UPDATER_SHARED_CACHE_POLICY_CONFIG.Name,
    });
    const existingPolicyId = existingPolicy?.CachePolicy?.Id;

    if (existingPolicyId) {
      return existingPolicyId;
    }

    const createPolicyResponse = await cloudfrontClient.createCachePolicy({
      CachePolicyConfig: HOT_UPDATER_SHARED_CACHE_POLICY_CONFIG,
    });
    const cachePolicyId = createPolicyResponse.CachePolicy?.Id;
    if (!cachePolicyId) {
      throw new Error("Failed to create shared cache policy");
    }
    return cachePolicyId;
  }

  private async getOrCreateLegacyCheckUpdateCachePolicy(
    cloudfrontClient: CloudFront,
  ): Promise<string> {
    const existingPolicy = await findInPaginatedCloudFrontList({
      listPage: async (marker) => {
        const listPoliciesResponse = await cloudfrontClient.listCachePolicies({
          Type: "custom",
          ...(marker ? { Marker: marker } : {}),
        });

        return {
          items: listPoliciesResponse.CachePolicyList?.Items ?? [],
          nextMarker: listPoliciesResponse.CachePolicyList?.NextMarker,
        };
      },
      matches: (policy) =>
        policy.CachePolicy?.CachePolicyConfig?.Name ===
        HOT_UPDATER_LEGACY_CHECK_UPDATE_CACHE_POLICY_CONFIG.Name,
    });
    const existingPolicyId = existingPolicy?.CachePolicy?.Id;

    if (existingPolicyId) {
      return existingPolicyId;
    }

    const createPolicyResponse = await cloudfrontClient.createCachePolicy({
      CachePolicyConfig: HOT_UPDATER_LEGACY_CHECK_UPDATE_CACHE_POLICY_CONFIG,
    });
    const cachePolicyId = createPolicyResponse.CachePolicy?.Id;
    if (!cachePolicyId) {
      throw new Error("Failed to create legacy check-update cache policy");
    }
    return cachePolicyId;
  }

  async getOrCreateKeyGroup(publicKey: string): Promise<{
    publicKeyId: string;
    keyGroupId: string;
  }> {
    const publicKeyHash = crypto
      .createHash("sha256")
      .update(publicKey)
      .digest("hex")
      .slice(0, 16);

    const cloudfrontClient = new CloudFront({
      region: this.region,
      credentials: this.credentials,
    });
    const listKgResp = await cloudfrontClient.listKeyGroups({});
    const existingKeyGroup = listKgResp.KeyGroupList?.Items?.find((kg: any) =>
      kg.KeyGroup?.KeyGroupConfig?.Name?.startsWith(
        `HotUpdaterKeyGroup-${publicKeyHash}`,
      ),
    );
    const existingPublicKeyId =
      existingKeyGroup?.KeyGroup?.KeyGroupConfig?.Items?.[0];
    const existingKeyGroupId = existingKeyGroup?.KeyGroup?.Id;
    if (existingPublicKeyId && existingKeyGroupId) {
      return {
        publicKeyId: existingPublicKeyId,
        keyGroupId: existingKeyGroupId,
      };
    }
    const callerReferencePub = `HotUpdaterPublicKey-${publicKeyHash}`;
    const publicKeyConfig = {
      CallerReference: callerReferencePub,
      Name: callerReferencePub,
      EncodedKey: publicKey,
      Comment: "HotUpdater public key for signed URL",
    };
    const createPubKeyResp = await cloudfrontClient.createPublicKey({
      PublicKeyConfig: publicKeyConfig,
    });
    const publicKeyId = createPubKeyResp.PublicKey?.Id;
    if (!publicKeyId) {
      throw new Error("Failed to create CloudFront public key");
    }
    const callerReferenceKg = `HotUpdaterKeyGroup-${publicKeyHash}`;
    const keyGroupConfig = {
      CallerReference: callerReferenceKg,
      Name: callerReferenceKg,
      Comment: "HotUpdater key group for signed URL",
      Items: [publicKeyId],
    };
    const createKgResp = await cloudfrontClient.createKeyGroup({
      KeyGroupConfig: keyGroupConfig,
    });
    const keyGroupId = createKgResp.KeyGroup?.Id;
    if (!keyGroupId) {
      throw new Error("Failed to create Key Group");
    }
    p.log.success(`Created new Key Group: ${keyGroupConfig.Name}`);
    return { publicKeyId, keyGroupId };
  }

  async createOrUpdateDistribution(options: {
    keyGroupId: string;
    bucketName: string;
    functionArn: string;
  }): Promise<{ distributionId: string; distributionDomain: string }> {
    const cloudfrontClient = new CloudFront({
      region: this.region,
      credentials: this.credentials,
    });
    let oacId: string;
    const accountId = options.functionArn.split(":")[4];
    if (!accountId) {
      throw new Error("Failed to get AWS account ID");
    }
    try {
      const listOacResp = await cloudfrontClient.listOriginAccessControls({});
      const existingOac = listOacResp.OriginAccessControlList?.Items?.find(
        (oac) => oac.Name === "HotUpdaterOAC",
      );
      if (existingOac?.Id) {
        oacId = existingOac.Id;
      } else {
        const createOacResp = await cloudfrontClient.createOriginAccessControl({
          OriginAccessControlConfig: {
            Name: "HotUpdaterOAC",
            OriginAccessControlOriginType: "s3",
            SigningBehavior: "always",
            SigningProtocol: "sigv4",
          },
        });
        if (!createOacResp.OriginAccessControl?.Id) {
          throw new Error(
            "Failed to create Origin Access Control: No ID returned",
          );
        }
        oacId = createOacResp.OriginAccessControl.Id;
      }
    } catch {
      throw new Error("Failed to get or create Origin Access Control");
    }
    if (!oacId) throw new Error("Failed to get Origin Access Control ID");

    const bucketDomain = `${options.bucketName}.s3.${this.region}.amazonaws.com`;
    let legacyCachePolicyId: string;
    let sharedCachePolicyId: string;
    try {
      legacyCachePolicyId =
        await this.getOrCreateLegacyCheckUpdateCachePolicy(cloudfrontClient);
    } catch {
      throw new Error("Failed to get or create legacy check-update cache policy");
    }
    try {
      sharedCachePolicyId =
        await this.getOrCreateSharedCachePolicy(cloudfrontClient);
    } catch {
      throw new Error("Failed to get or create shared cache policy");
    }

    const matchingDistributions: Array<{ Id: string; DomainName: string }> = [];
    try {
      const listResp = await cloudfrontClient.listDistributions({});
      const items = listResp.DistributionList?.Items || [];
      for (const dist of items) {
        const origins = dist.Origins?.Items || [];
        if (origins.some((origin) => origin.DomainName === bucketDomain)) {
          matchingDistributions.push({
            Id: dist.Id!,
            DomainName: dist.DomainName!,
          });
        }
      }
    } catch (error) {
      console.error("Error listing CloudFront distributions:", error);
    }
    let selectedDistribution: { Id: string; DomainName: string } | null = null;
    if (matchingDistributions.length === 1) {
      selectedDistribution = matchingDistributions[0];
    } else if (matchingDistributions.length > 1) {
      const selectedDistributionStr = await p.select({
        message:
          "Multiple CloudFront distributions found. Please select one to use:",
        options: matchingDistributions.map((dist) => ({
          value: JSON.stringify(dist),
          label: `${dist.Id} (${dist.DomainName})`,
        })),
      });
      if (p.isCancel(selectedDistributionStr)) process.exit(0);
      selectedDistribution = JSON.parse(selectedDistributionStr);
    }
    const newOverrides = buildDistributionConfigOverrides({
      bucketName: options.bucketName,
      bucketDomain,
      functionArn: options.functionArn,
      keyGroupId: options.keyGroupId,
      oacId,
      legacyCachePolicyId,
      sharedCachePolicyId,
    });

    if (selectedDistribution) {
      p.log.success(
        `Existing CloudFront distribution selected. Distribution ID: ${selectedDistribution.Id}.`,
      );
      try {
        const { DistributionConfig, ETag } =
          await cloudfrontClient.getDistributionConfig({
            Id: selectedDistribution.Id,
          });
        if (!DistributionConfig) {
          throw new Error("CloudFront distribution config was not returned");
        }
        const finalConfig = applyDistributionConfigOverrides(
          DistributionConfig,
          newOverrides,
        );
        await cloudfrontClient.updateDistribution({
          Id: selectedDistribution.Id,
          IfMatch: ETag,
          DistributionConfig: finalConfig,
        });
        p.log.success(
          "CloudFront distribution updated with new Lambda function ARN.",
        );
        await cloudfrontClient.createInvalidation({
          DistributionId: selectedDistribution.Id,
          InvalidationBatch: {
            CallerReference: new Date().toISOString(),
            Paths: { Quantity: 1, Items: ["/*"] },
          },
        });
        p.log.success("Cache invalidation request completed.");
        return {
          distributionId: selectedDistribution.Id,
          distributionDomain: selectedDistribution.DomainName,
        };
      } catch (err) {
        p.log.error(
          `Failed to update CloudFront distribution: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    }

    // Create a new distribution if none exists
    const finalDistributionConfig = buildDistributionConfig({
      bucketName: options.bucketName,
      bucketDomain,
      functionArn: options.functionArn,
      keyGroupId: options.keyGroupId,
      oacId,
      legacyCachePolicyId,
      sharedCachePolicyId,
    });

    try {
      const distResp = await cloudfrontClient.createDistribution({
        DistributionConfig: finalDistributionConfig,
      });
      if (!distResp.Distribution?.Id || !distResp.Distribution?.DomainName) {
        throw new Error(
          "Failed to create CloudFront distribution: No ID or DomainName returned",
        );
      }
      const distributionId = distResp.Distribution.Id;
      const distributionDomain = distResp.Distribution.DomainName;
      p.log.success(
        `Created new CloudFront distribution. Distribution ID: ${distributionId}`,
      );
      let retryCount = 0;
      await p.tasks([
        {
          title: "Waiting for CloudFront distribution to complete...",
          task: async (message) => {
            while (retryCount < 600) {
              try {
                const status = await cloudfrontClient.getDistribution({
                  Id: distributionId,
                });
                if (status.Distribution?.Status === "Deployed") {
                  return "CloudFront distribution deployment completed.";
                }
                throw new Error("Retry");
              } catch (_err) {
                if (retryCount++ >= 5) {
                  message(
                    `CloudFront distribution is still in progress. This may take a few minutes. (${retryCount})`,
                  );
                }
                await delay(1000);
              }
            }
            p.log.error("CloudFront distribution deployment timed out.");
            process.exit(1);
          },
        },
      ]);
      return { distributionId, distributionDomain };
    } catch (error) {
      p.log.error(
        `CloudFront distribution creation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
}
