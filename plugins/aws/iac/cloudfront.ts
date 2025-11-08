import {
  CloudFront,
  type DistributionConfig,
} from "@aws-sdk/client-cloudfront";
import { p } from "@hot-updater/cli-tools";
import crypto from "crypto";
import { delay, merge } from "es-toolkit";
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
    const newOverrides: Partial<DistributionConfig> = {
      Origins: {
        Quantity: 1,
        Items: [
          {
            Id: options.bucketName,
            DomainName: bucketDomain,
            OriginAccessControlId: oacId,
            S3OriginConfig: { OriginAccessIdentity: "" },
          },
        ],
      },
      DefaultCacheBehavior: {
        TargetOriginId: options.bucketName,
        ViewerProtocolPolicy: "redirect-to-https",
        TrustedKeyGroups: {
          Enabled: true,
          Quantity: 1,
          Items: [options.keyGroupId],
        },
        ForwardedValues: {
          QueryString: true,
          Cookies: { Forward: "none" },
          QueryStringCacheKeys: {
            Quantity: 0,
            Items: [],
          },
        },
        MinTTL: 0,
        SmoothStreaming: false,
        Compress: true,
        FieldLevelEncryptionId: "",
        AllowedMethods: {
          Quantity: 2,
          Items: ["HEAD", "GET"],
          CachedMethods: {
            Quantity: 2,
            Items: ["HEAD", "GET"],
          },
        },
      },
      CacheBehaviors: {
        Quantity: 2,
        Items: [
          // no cache
          {
            PathPattern: "/api/check-update",
            TargetOriginId: options.bucketName,
            ViewerProtocolPolicy: "redirect-to-https",
            LambdaFunctionAssociations: {
              Quantity: 1,
              Items: [
                {
                  EventType: "origin-request",
                  LambdaFunctionARN: options.functionArn,
                },
              ],
            },
            MinTTL: 0,
            DefaultTTL: 0,
            MaxTTL: 0,
            SmoothStreaming: false,
            Compress: true,
            FieldLevelEncryptionId: "",
            AllowedMethods: {
              Quantity: 2,
              Items: ["HEAD", "GET"],
              CachedMethods: {
                Quantity: 2,
                Items: ["HEAD", "GET"],
              },
            },
            ForwardedValues: {
              QueryString: false,
              Cookies: { Forward: "none" },
              Headers: {
                Quantity: 6,
                Items: [
                  "x-bundle-id",
                  "x-app-version",
                  "x-app-platform",
                  "x-min-bundle-id",
                  "x-channel",
                  "x-fingerprint-hash",
                ],
              },
              QueryStringCacheKeys: {
                Quantity: 0,
                Items: [],
              },
            },
          },
          // /api/check-update/fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId
          // /api/check-update/app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId
          {
            PathPattern: "/api/check-update/*",
            TargetOriginId: options.bucketName,
            ViewerProtocolPolicy: "redirect-to-https",
            LambdaFunctionAssociations: {
              Quantity: 1,
              Items: [
                {
                  EventType: "origin-request",
                  LambdaFunctionARN: options.functionArn,
                },
              ],
            },
            MinTTL: 0,
            DefaultTTL: 31536000,
            MaxTTL: 31536000,
            SmoothStreaming: false,
            Compress: true,
            FieldLevelEncryptionId: "",
            AllowedMethods: {
              Quantity: 2,
              Items: ["HEAD", "GET"],
              CachedMethods: {
                Quantity: 2,
                Items: ["HEAD", "GET"],
              },
            },
            ForwardedValues: {
              QueryString: false,
              Cookies: { Forward: "none" },
              Headers: {
                Quantity: 0,
                Items: [],
              },
              QueryStringCacheKeys: {
                Quantity: 0,
                Items: [],
              },
            },
          },
        ],
      },
    };

    if (selectedDistribution) {
      p.log.success(
        `Existing CloudFront distribution selected. Distribution ID: ${selectedDistribution.Id}.`,
      );
      try {
        const { DistributionConfig, ETag } =
          await cloudfrontClient.getDistributionConfig({
            Id: selectedDistribution.Id,
          });
        const finalConfig: DistributionConfig = merge(
          DistributionConfig ?? {},
          newOverrides,
        ) as DistributionConfig;
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
    const finalDistributionConfig: DistributionConfig = {
      CallerReference: new Date().toISOString(),
      Comment: "Hot Updater CloudFront distribution",
      Enabled: true,
      Origins: {
        Quantity: 1,
        Items: [
          {
            Id: options.bucketName,
            DomainName: bucketDomain,
            OriginAccessControlId: oacId,
            S3OriginConfig: { OriginAccessIdentity: "" },
          },
        ],
      },
      DefaultCacheBehavior: {
        TargetOriginId: options.bucketName,
        ViewerProtocolPolicy: "redirect-to-https",
        TrustedKeyGroups: {
          Enabled: true,
          Quantity: 1,
          Items: [options.keyGroupId],
        },
        ForwardedValues: {
          QueryString: true,
          Cookies: { Forward: "none" },
          QueryStringCacheKeys: {
            Quantity: 0,
            Items: [],
          },
        },
        MinTTL: 0,
        SmoothStreaming: false,
        Compress: true,
        FieldLevelEncryptionId: "",
        AllowedMethods: {
          Quantity: 2,
          Items: ["HEAD", "GET"],
          CachedMethods: {
            Quantity: 2,
            Items: ["HEAD", "GET"],
          },
        },
      },
      CacheBehaviors: {
        Quantity: 2,
        Items: [
          // no cache
          {
            PathPattern: "/api/check-update",
            TargetOriginId: options.bucketName,
            ViewerProtocolPolicy: "redirect-to-https",
            LambdaFunctionAssociations: {
              Quantity: 1,
              Items: [
                {
                  EventType: "origin-request",
                  LambdaFunctionARN: options.functionArn,
                },
              ],
            },
            MinTTL: 0,
            DefaultTTL: 0,
            MaxTTL: 0,
            SmoothStreaming: false,
            Compress: true,
            FieldLevelEncryptionId: "",
            AllowedMethods: {
              Quantity: 2,
              Items: ["HEAD", "GET"],
              CachedMethods: {
                Quantity: 2,
                Items: ["HEAD", "GET"],
              },
            },
            ForwardedValues: {
              QueryString: false,
              Cookies: { Forward: "none" },
              Headers: {
                Quantity: 6,
                Items: [
                  "x-bundle-id",
                  "x-app-version",
                  "x-app-platform",
                  "x-min-bundle-id",
                  "x-channel",
                  "x-fingerprint-hash",
                ],
              },
              QueryStringCacheKeys: {
                Quantity: 0,
                Items: [],
              },
            },
          },
          // /api/check-update/fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId
          // /api/check-update/app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId
          {
            PathPattern: "/api/check-update/*",
            TargetOriginId: options.bucketName,
            ViewerProtocolPolicy: "redirect-to-https",
            LambdaFunctionAssociations: {
              Quantity: 1,
              Items: [
                {
                  EventType: "origin-request",
                  LambdaFunctionARN: options.functionArn,
                },
              ],
            },
            MinTTL: 0,
            DefaultTTL: 31536000,
            MaxTTL: 31536000,
            SmoothStreaming: false,
            Compress: true,
            FieldLevelEncryptionId: "",
            AllowedMethods: {
              Quantity: 2,
              Items: ["HEAD", "GET"],
              CachedMethods: {
                Quantity: 2,
                Items: ["HEAD", "GET"],
              },
            },
            ForwardedValues: {
              QueryString: false,
              Cookies: { Forward: "none" },
              Headers: {
                Quantity: 0,
                Items: [],
              },
              QueryStringCacheKeys: {
                Quantity: 0,
                Items: [],
              },
            },
          },
        ],
      },
      DefaultRootObject: "index.html",
      ViewerCertificate: { CloudFrontDefaultCertificate: true },
      Restrictions: {
        GeoRestriction: { RestrictionType: "none", Quantity: 0 },
      },
      PriceClass: "PriceClass_All",
      Aliases: { Quantity: 0, Items: [] },
    };

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
