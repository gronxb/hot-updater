import crypto from "crypto";

import {
  type CachePolicyConfig,
  CloudFront,
  type OriginRequestPolicyConfig,
} from "@aws-sdk/client-cloudfront";
import { makeEnv, MissingInitInputsError, p } from "@hot-updater/cli-tools";
import { delay } from "es-toolkit";

import { resolveAwsDistributionGeneration } from "./awsInfrastructureState";
import {
  applyDistributionConfigOverrides,
  buildDistributionConfig,
  buildDistributionConfigOverrides,
  buildOriginRequestPolicyConfig,
  buildReleaseCatalogCachePolicyConfig,
  buildSharedCachePolicyConfig,
  HOT_UPDATER_CACHE_BEHAVIOR_PATHS,
  HOT_UPDATER_RELEASE_CATALOG_BEHAVIOR_PATHS,
} from "./cloudfrontDistributionConfig";
import {
  collectPaginatedCloudFrontList,
  findInPaginatedCloudFrontList,
} from "./cloudfrontPagination";
import type { EdgeDeployment } from "./iam";
import type { AwsRegion } from "./regionLocationMap";

export type CloudFrontDistribution = {
  readonly DomainName: string;
  readonly Id: string;
};

/**
 * Hot Updater's policies modified this recently may be another init's,
 * which it is about to attach to its distribution.
 */
const POLICY_CLEANUP_MIN_AGE_MS = 60 * 60 * 1000;

const isNamed = (error: unknown, ...names: readonly string[]) =>
  error instanceof Error && names.includes(error.name);

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

  private async getOrCreateCachePolicy(
    cloudfrontClient: CloudFront,
    config: CachePolicyConfig,
  ): Promise<string> {
    const find = async () =>
      (
        await findInPaginatedCloudFrontList({
          listPage: async (marker) => {
            const listPoliciesResponse =
              await cloudfrontClient.listCachePolicies({
                Type: "custom",
                ...(marker ? { Marker: marker } : {}),
              });

            return {
              items: listPoliciesResponse.CachePolicyList?.Items ?? [],
              nextMarker: listPoliciesResponse.CachePolicyList?.NextMarker,
            };
          },
          matches: (policy) =>
            policy.CachePolicy?.CachePolicyConfig?.Name === config.Name,
        })
      )?.CachePolicy?.Id;
    // The name holds the content, and other deployments in the account may
    // use the policy: an existing one is used as it is.
    const existingPolicyId = await find();
    if (existingPolicyId) return existingPolicyId;

    try {
      const createPolicyResponse = await cloudfrontClient.createCachePolicy({
        CachePolicyConfig: config,
      });
      const cachePolicyId = createPolicyResponse.CachePolicy?.Id;
      if (!cachePolicyId) {
        throw new Error("Failed to create shared cache policy");
      }
      return cachePolicyId;
    } catch (error) {
      // Another init with the same settings created it first.
      if (isNamed(error, "CachePolicyAlreadyExists")) {
        const createdPolicyId = await find();
        if (createdPolicyId) return createdPolicyId;
      }
      throw error;
    }
  }

  private async getOrCreateOriginRequestPolicy(
    cloudfrontClient: CloudFront,
    config: OriginRequestPolicyConfig,
  ): Promise<string> {
    const find = async () =>
      (
        await findInPaginatedCloudFrontList({
          listPage: async (marker) => {
            const response = await cloudfrontClient.listOriginRequestPolicies({
              Type: "custom",
              ...(marker ? { Marker: marker } : {}),
            });
            return {
              items: response.OriginRequestPolicyList?.Items ?? [],
              nextMarker: response.OriginRequestPolicyList?.NextMarker,
            };
          },
          matches: (policy) =>
            policy.OriginRequestPolicy?.OriginRequestPolicyConfig?.Name ===
            config.Name,
        })
      )?.OriginRequestPolicy?.Id;
    const existingPolicyId = await find();
    if (existingPolicyId) return existingPolicyId;

    try {
      const response = await cloudfrontClient.createOriginRequestPolicy({
        OriginRequestPolicyConfig: config,
      });
      const policyId = response.OriginRequestPolicy?.Id;
      if (!policyId) throw new Error("Failed to create origin request policy");
      return policyId;
    } catch (error) {
      // Another init with the same settings created it first.
      if (isNamed(error, "OriginRequestPolicyAlreadyExists")) {
        const createdPolicyId = await find();
        if (createdPolicyId) return createdPolicyId;
      }
      throw error;
    }
  }

  /**
   * Deletes Hot Updater's cache and origin request policies that no
   * distribution uses, such as rc.20's and those of settings no deployment
   * has anymore, since an account holds 20 of each. It is best-effort and
   * never fails init: CloudFront refuses to delete a policy a distribution
   * uses, and a policy modified within the hour stays, since it may be
   * another init's, about to be attached.
   */
  private async deleteUnusedPolicies(
    cloudfrontClient: CloudFront,
    used: ReadonlySet<string>,
  ): Promise<void> {
    const now = Date.now();
    const isUnused = (
      id: string | undefined,
      name: string | undefined,
      lastModified: Date | undefined,
    ): id is string =>
      id !== undefined &&
      !used.has(id) &&
      name?.startsWith("HotUpdater") === true &&
      lastModified !== undefined &&
      now - lastModified.getTime() >= POLICY_CLEANUP_MIN_AGE_MS;
    const deleteQuietly = async (
      name: string | undefined,
      remove: () => Promise<unknown>,
      expected: readonly string[],
    ) => {
      try {
        await remove();
        p.log.info(`Deleted unused CloudFront policy: ${name}`);
      } catch (error) {
        if (isNamed(error, ...expected, "PreconditionFailed")) return;
        p.log.warn(
          `Could not delete unused CloudFront policy ${name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    };
    try {
      const cachePolicies = await collectPaginatedCloudFrontList({
        listPage: async (marker) => {
          const response = await cloudfrontClient.listCachePolicies({
            Type: "custom",
            ...(marker ? { Marker: marker } : {}),
          });
          return {
            items: response.CachePolicyList?.Items ?? [],
            nextMarker: response.CachePolicyList?.NextMarker,
          };
        },
      });
      for (const { CachePolicy: policy } of cachePolicies) {
        const id = policy?.Id;
        const name = policy?.CachePolicyConfig?.Name;
        if (!isUnused(id, name, policy?.LastModifiedTime)) continue;
        await deleteQuietly(name, async () => {
          const { ETag } = await cloudfrontClient.getCachePolicy({ Id: id });
          await cloudfrontClient.deleteCachePolicy({ Id: id, IfMatch: ETag });
        }, ["CachePolicyInUse", "NoSuchCachePolicy"]);
      }
      const originRequestPolicies = await collectPaginatedCloudFrontList({
        listPage: async (marker) => {
          const response = await cloudfrontClient.listOriginRequestPolicies({
            Type: "custom",
            ...(marker ? { Marker: marker } : {}),
          });
          return {
            items: response.OriginRequestPolicyList?.Items ?? [],
            nextMarker: response.OriginRequestPolicyList?.NextMarker,
          };
        },
      });
      for (const { OriginRequestPolicy: policy } of originRequestPolicies) {
        const id = policy?.Id;
        const name = policy?.OriginRequestPolicyConfig?.Name;
        if (!isUnused(id, name, policy?.LastModifiedTime)) continue;
        await deleteQuietly(name, async () => {
          const { ETag } = await cloudfrontClient.getOriginRequestPolicy({
            Id: id,
          });
          await cloudfrontClient.deleteOriginRequestPolicy({
            Id: id,
            IfMatch: ETag,
          });
        }, ["OriginRequestPolicyInUse", "NoSuchOriginRequestPolicy"]);
      }
    } catch (error) {
      p.log.warn(
        `Could not list CloudFront policies to delete unused ones: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Where `distributionId` stands with the function named `functionName`:
   * whether its last update finished deploying, and the function versions
   * its behaviors run. Undefined when the distribution is gone.
   */
  async edgeDeploymentOf(
    distributionId: string,
    functionName: string,
  ): Promise<EdgeDeployment | undefined> {
    const cloudfrontClient = new CloudFront({
      region: this.region,
      credentials: this.credentials,
    });
    try {
      const { Distribution } = await cloudfrontClient.getDistribution({
        Id: distributionId,
      });
      const config = Distribution?.DistributionConfig;
      const versions = [
        config?.DefaultCacheBehavior,
        ...(config?.CacheBehaviors?.Items ?? []),
      ]
        .flatMap(
          (behavior) => behavior?.LambdaFunctionAssociations?.Items ?? [],
        )
        .map(({ LambdaFunctionARN }) => LambdaFunctionARN?.split(":") ?? [])
        .filter((parts) => parts[6] === functionName && parts[7] !== undefined)
        .map((parts) => parts[7]!);
      return {
        deployed: Distribution?.Status === "Deployed",
        versions: [...new Set(versions)],
      };
    } catch (error) {
      if (isNamed(error, "NoSuchDistribution")) return undefined;
      throw error;
    }
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
    const existingKeyGroup = listKgResp.KeyGroupList?.Items?.find((kg) =>
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
    /** The headers the server's client-route policy reads; none when client routes are public. */
    clientHeaders: readonly string[];
    /** From `pluginCacheBehaviorPaths`: the plugins' client endpoints, sent to the function. */
    pluginPaths?: readonly string[];
    distribution?: CloudFrontDistribution | null;
    distributionId?: string;
    nonInteractive?: boolean;
  }): Promise<{ distributionId: string; distributionDomain: string }> {
    const cloudfrontClient = new CloudFront({
      region: this.region,
      credentials: this.credentials,
    });
    const selectedDistribution =
      options.distribution === undefined
        ? await this.selectDistribution({
            bucketName: options.bucketName,
            distributionId: options.distributionId,
            nonInteractive: options.nonInteractive,
          })
        : options.distribution;
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
    const resolvePolicies = async () => {
      try {
        const [
          sharedCachePolicyId,
          releaseCatalogCachePolicyId,
          originRequestPolicyId,
        ] = await Promise.all([
          this.getOrCreateCachePolicy(
            cloudfrontClient,
            buildSharedCachePolicyConfig(options.clientHeaders),
          ),
          this.getOrCreateCachePolicy(
            cloudfrontClient,
            buildReleaseCatalogCachePolicyConfig(options.clientHeaders),
          ),
          this.getOrCreateOriginRequestPolicy(
            cloudfrontClient,
            buildOriginRequestPolicyConfig(options.clientHeaders),
          ),
        ]);
        return {
          originRequestPolicyId,
          releaseCatalogCachePolicyId,
          sharedCachePolicyId,
        };
      } catch (error) {
        throw new Error(
          `Failed to get or create CloudFront request policies: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    };
    let policies = await resolvePolicies();
    /**
     * Runs `apply` with the policies, and once more with policies made again
     * when a policy it named is gone: another deployment's init can delete
     * an older policy it found unused, after this one found it.
     */
    const withPolicies = async <T>(
      apply: (current: typeof policies) => Promise<T>,
    ): Promise<T> => {
      try {
        return await apply(policies);
      } catch (error) {
        if (!isNamed(error, "NoSuchCachePolicy", "NoSuchOriginRequestPolicy")) {
          throw error;
        }
        policies = await resolvePolicies();
        return await apply(policies);
      }
    };
    const configOptions = (current: typeof policies) => ({
      bucketName: options.bucketName,
      bucketDomain,
      functionArn: options.functionArn,
      keyGroupId: options.keyGroupId,
      oacId,
      ...current,
      pluginPaths: options.pluginPaths ?? [],
    });
    const usedPolicies = () =>
      new Set([
        policies.sharedCachePolicyId,
        policies.releaseCatalogCachePolicyId,
        policies.originRequestPolicyId,
      ]);

    if (selectedDistribution) {
      await makeEnv({
        HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID: selectedDistribution.Id,
      });
      p.log.success(
        `Existing CloudFront distribution selected. Distribution ID: ${selectedDistribution.Id}.`,
      );
      try {
        await withPolicies(async (current) => {
          const { DistributionConfig, ETag } =
            await cloudfrontClient.getDistributionConfig({
              Id: selectedDistribution.Id,
            });
          if (!DistributionConfig) {
            throw new Error("CloudFront distribution config was not returned");
          }
          const finalConfig = applyDistributionConfigOverrides(
            DistributionConfig,
            buildDistributionConfigOverrides(configOptions(current)),
          );
          await cloudfrontClient.updateDistribution({
            Id: selectedDistribution.Id,
            IfMatch: ETag,
            DistributionConfig: finalConfig,
          });
        });
        p.log.success(
          "CloudFront distribution updated with new Lambda function ARN.",
        );
        await this.deleteUnusedPolicies(cloudfrontClient, usedPolicies());
        await cloudfrontClient.createInvalidation({
          DistributionId: selectedDistribution.Id,
          InvalidationBatch: {
            CallerReference: new Date().toISOString(),
            Paths: {
              Quantity:
                HOT_UPDATER_CACHE_BEHAVIOR_PATHS.length +
                HOT_UPDATER_RELEASE_CATALOG_BEHAVIOR_PATHS.length +
                (options.pluginPaths?.length ?? 0),
              Items: [
                ...HOT_UPDATER_CACHE_BEHAVIOR_PATHS,
                ...HOT_UPDATER_RELEASE_CATALOG_BEHAVIOR_PATHS,
                ...(options.pluginPaths ?? []),
              ],
            },
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
    try {
      const distResp = await withPolicies((current) =>
        cloudfrontClient.createDistribution({
          DistributionConfig: buildDistributionConfig(configOptions(current)),
        }),
      );
      if (!distResp.Distribution?.Id || !distResp.Distribution?.DomainName) {
        throw new Error(
          "Failed to create CloudFront distribution: No ID or DomainName returned",
        );
      }
      const distributionId = distResp.Distribution.Id;
      const distributionDomain = distResp.Distribution.DomainName;
      await makeEnv({
        HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID: distributionId,
      });
      await this.deleteUnusedPolicies(cloudfrontClient, usedPolicies());
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
              } catch {
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

  async selectDistribution({
    bucketName,
    distributionId,
    nonInteractive,
  }: {
    readonly bucketName: string;
    readonly distributionId?: string;
    readonly nonInteractive?: boolean;
  }): Promise<CloudFrontDistribution | null> {
    const bucketDomain = `${bucketName}.s3.${this.region}.amazonaws.com`;
    const cloudfrontClient = new CloudFront({
      region: this.region,
      credentials: this.credentials,
    });
    const distributions = await collectPaginatedCloudFrontList({
      listPage: async (marker) => {
        const options = marker ? { Marker: marker } : {};
        const response = await cloudfrontClient.listDistributions(options);
        return {
          items: response.DistributionList?.Items ?? [],
          nextMarker: response.DistributionList?.NextMarker,
        };
      },
    });
    const matchingDistributions = distributions.flatMap((distribution) => {
      const matchesBucket = (distribution.Origins?.Items ?? []).some(
        (origin) => origin.DomainName === bucketDomain,
      );
      return matchesBucket && distribution.Id && distribution.DomainName
        ? [{ Id: distribution.Id, DomainName: distribution.DomainName }]
        : [];
    });
    const savedDistribution = matchingDistributions.find(
      (distribution) => distribution.Id === distributionId,
    );
    const savedDistributionExists = distributions.some(
      (distribution) => distribution.Id === distributionId,
    );
    if (nonInteractive) {
      if (savedDistribution) {
        return savedDistribution;
      }
      if (!distributionId) {
        return null;
      }
      if (!savedDistributionExists) {
        p.log.warn(
          "Saved CloudFront distribution was not found. A new distribution will be created.",
        );
        return null;
      }
      throw new MissingInitInputsError([
        "HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID",
      ]);
    }
    if (distributionId && !savedDistribution) {
      p.log.warn(
        savedDistributionExists
          ? "Saved CloudFront distribution does not use the selected S3 bucket. Select a distribution again."
          : "Saved CloudFront distribution was not found. A new distribution will be created unless another distribution is selected.",
      );
    }
    if (matchingDistributions.length === 0) {
      return null;
    }

    const legacyDistributionIds = new Set<string>();
    await Promise.all(
      matchingDistributions.map(async (distribution) => {
        const generation = await resolveAwsDistributionGeneration({
          domainName: distribution.DomainName,
        });
        if (generation === "v0") {
          legacyDistributionIds.add(distribution.Id);
        }
      }),
    );

    const createNewDistribution = "__create-new-cloudfront-distribution__";
    const reusableSavedDistributionId =
      savedDistribution && !legacyDistributionIds.has(savedDistribution.Id)
        ? savedDistribution.Id
        : undefined;
    const selectedDistributionId = await p.select<string>({
      initialValue: reusableSavedDistributionId ?? createNewDistribution,
      message: "Select a CloudFront distribution:",
      options: [
        {
          value: createNewDistribution,
          label: "Create New CloudFront Distribution",
        },
        ...matchingDistributions.map((distribution) => {
          const isLegacy = legacyDistributionIds.has(distribution.Id);
          return {
            value: distribution.Id,
            label: `${distribution.Id} (${distribution.DomainName})${isLegacy ? " (v0, deprecated)" : ""}`,
            disabled: isLegacy,
          };
        }),
      ],
    });
    if (p.isCancel(selectedDistributionId)) {
      process.exit(0);
    }
    if (selectedDistributionId === createNewDistribution) {
      return null;
    }
    return (
      matchingDistributions.find(
        (distribution) => distribution.Id === selectedDistributionId,
      ) ?? null
    );
  }
}
