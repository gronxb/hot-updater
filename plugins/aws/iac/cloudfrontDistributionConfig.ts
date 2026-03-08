import type {
  AllowedMethods,
  DistributionConfig,
  Origin,
} from "@aws-sdk/client-cloudfront";

// AWS-managed CloudFront cache policy IDs. These are global IDs, not account-specific.
// Docs: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html
export const HOT_UPDATER_MANAGED_CACHE_POLICY_IDS = {
  cachingDisabled: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
  useOriginCacheControlHeaders: "83da9c7e-98b4-4e11-a168-04f0df8e2c65",
} as const;

export const HOT_UPDATER_LEGACY_CHECK_UPDATE_HEADERS = [
  "x-bundle-id",
  "x-app-version",
  "x-app-platform",
  "x-min-bundle-id",
  "x-channel",
  "x-fingerprint-hash",
] as const;

export type DistributionConfigOverrides = {
  Origins: NonNullable<DistributionConfig["Origins"]>;
  DefaultCacheBehavior: NonNullable<DistributionConfig["DefaultCacheBehavior"]>;
  CacheBehaviors: NonNullable<DistributionConfig["CacheBehaviors"]>;
};

type DefaultBehavior = NonNullable<DistributionConfig["DefaultCacheBehavior"]>;
type CacheBehavior = NonNullable<
  NonNullable<DistributionConfig["CacheBehaviors"]>["Items"]
>[number];
type CacheBehaviorTemplate = {
  pathPattern: string;
  cachePolicyId: string;
  needsOriginRequestPolicy?: boolean;
};

const READ_ONLY_METHODS: AllowedMethods = {
  Quantity: 2,
  Items: ["HEAD", "GET"],
  CachedMethods: {
    Quantity: 2,
    Items: ["HEAD", "GET"],
  },
};

const EMPTY_FUNCTION_ASSOCIATIONS = {
  Quantity: 0,
} as const;

const EMPTY_LAMBDA_FUNCTION_ASSOCIATIONS = {
  Quantity: 0,
} as const;

const HOT_UPDATER_BEHAVIOR_BASE = {
  ViewerProtocolPolicy: "redirect-to-https",
  SmoothStreaming: false,
  Compress: true,
  FunctionAssociations: EMPTY_FUNCTION_ASSOCIATIONS,
  FieldLevelEncryptionId: "",
  AllowedMethods: READ_ONLY_METHODS,
} as const;

const HOT_UPDATER_CACHE_BEHAVIOR_TEMPLATES: readonly CacheBehaviorTemplate[] = [
  {
    pathPattern: "/api/check-update",
    cachePolicyId: HOT_UPDATER_MANAGED_CACHE_POLICY_IDS.cachingDisabled,
    needsOriginRequestPolicy: true,
  },
  {
    pathPattern: "/api/check-update/*",
    cachePolicyId:
      HOT_UPDATER_MANAGED_CACHE_POLICY_IDS.useOriginCacheControlHeaders,
  },
];

const omitLegacyCacheFields = <
  T extends {
    ForwardedValues?: unknown;
    MinTTL?: unknown;
    DefaultTTL?: unknown;
    MaxTTL?: unknown;
  },
>(
  value: T,
) => {
  const {
    ForwardedValues: _forwardedValues,
    MinTTL: _minTTL,
    DefaultTTL: _defaultTTL,
    MaxTTL: _maxTTL,
    ...rest
  } = value;
  return rest;
};

const sanitizeDefaultBehavior = (
  behavior: DefaultBehavior,
): DefaultBehavior => ({
  ...omitLegacyCacheFields(behavior),
  LambdaFunctionAssociations:
    behavior.LambdaFunctionAssociations ?? EMPTY_LAMBDA_FUNCTION_ASSOCIATIONS,
  FunctionAssociations:
    behavior.FunctionAssociations ?? EMPTY_FUNCTION_ASSOCIATIONS,
});

const sanitizeCacheBehavior = (behavior: CacheBehavior): CacheBehavior => ({
  ...omitLegacyCacheFields(behavior),
  LambdaFunctionAssociations:
    behavior.LambdaFunctionAssociations ?? EMPTY_LAMBDA_FUNCTION_ASSOCIATIONS,
  FunctionAssociations:
    behavior.FunctionAssociations ?? EMPTY_FUNCTION_ASSOCIATIONS,
});

const sanitizeDistributionConfig = (
  distributionConfig: DistributionConfig,
): DistributionConfig => ({
  ...distributionConfig,
  DefaultCacheBehavior: distributionConfig.DefaultCacheBehavior
    ? sanitizeDefaultBehavior(distributionConfig.DefaultCacheBehavior)
    : distributionConfig.DefaultCacheBehavior,
  CacheBehaviors: distributionConfig.CacheBehaviors
    ? {
        Quantity: distributionConfig.CacheBehaviors.Quantity,
        Items: (distributionConfig.CacheBehaviors.Items ?? []).map((behavior) =>
          sanitizeCacheBehavior(behavior),
        ),
      }
    : distributionConfig.CacheBehaviors,
});

const buildOriginRequestLambdaAssociations = (functionArn: string) => ({
  Quantity: 1,
  Items: [
    {
      EventType: "origin-request" as const,
      LambdaFunctionARN: functionArn,
    },
  ],
});

const buildS3Origin = (options: {
  bucketName: string;
  bucketDomain: string;
  oacId: string;
}): Origin => ({
  Id: options.bucketName,
  DomainName: options.bucketDomain,
  OriginAccessControlId: options.oacId,
  S3OriginConfig: { OriginAccessIdentity: "" },
  CustomHeaders: {
    Quantity: 0,
  },
});

const buildSharedBehavior = (targetOriginId: string) => ({
  TargetOriginId: targetOriginId,
  ...HOT_UPDATER_BEHAVIOR_BASE,
});

const buildDefaultCacheBehavior = (options: {
  bucketName: string;
  keyGroupId: string;
}): DefaultBehavior => ({
  ...buildSharedBehavior(options.bucketName),
  TrustedKeyGroups: {
    Enabled: true,
    Quantity: 1,
    Items: [options.keyGroupId],
  },
  CachePolicyId:
    HOT_UPDATER_MANAGED_CACHE_POLICY_IDS.useOriginCacheControlHeaders,
  LambdaFunctionAssociations: EMPTY_LAMBDA_FUNCTION_ASSOCIATIONS,
});

const buildCacheBehavior = (
  template: CacheBehaviorTemplate,
  options: {
    bucketName: string;
    functionArn: string;
    originRequestPolicyId: string;
  },
): CacheBehavior => ({
  ...buildSharedBehavior(options.bucketName),
  PathPattern: template.pathPattern,
  CachePolicyId: template.cachePolicyId,
  LambdaFunctionAssociations: buildOriginRequestLambdaAssociations(
    options.functionArn,
  ),
  ...(template.needsOriginRequestPolicy
    ? { OriginRequestPolicyId: options.originRequestPolicyId }
    : {}),
});

const mergeOriginWithExisting = (
  existingOrigin: Origin | undefined,
  overrideOrigin: Origin,
): Origin => ({
  ...existingOrigin,
  ...overrideOrigin,
  CustomHeaders: existingOrigin?.CustomHeaders ?? {
    Quantity: 0,
  },
});

const mergeBehaviorWithExisting = <T extends DefaultBehavior | CacheBehavior>(
  existingBehavior: T | undefined,
  overrideBehavior: T,
): T => ({
  ...omitLegacyCacheFields(existingBehavior ?? ({} as T)),
  ...overrideBehavior,
  LambdaFunctionAssociations:
    overrideBehavior.LambdaFunctionAssociations ??
    existingBehavior?.LambdaFunctionAssociations ??
    EMPTY_LAMBDA_FUNCTION_ASSOCIATIONS,
  FunctionAssociations:
    overrideBehavior.FunctionAssociations ??
    existingBehavior?.FunctionAssociations ??
    EMPTY_FUNCTION_ASSOCIATIONS,
});

export const buildDistributionConfigOverrides = (options: {
  bucketName: string;
  bucketDomain: string;
  functionArn: string;
  keyGroupId: string;
  oacId: string;
  originRequestPolicyId: string;
}): DistributionConfigOverrides => ({
  Origins: {
    Quantity: 1,
    Items: [
      buildS3Origin({
        bucketName: options.bucketName,
        bucketDomain: options.bucketDomain,
        oacId: options.oacId,
      }),
    ],
  },
  DefaultCacheBehavior: buildDefaultCacheBehavior({
    bucketName: options.bucketName,
    keyGroupId: options.keyGroupId,
  }),
  CacheBehaviors: {
    Quantity: HOT_UPDATER_CACHE_BEHAVIOR_TEMPLATES.length,
    Items: HOT_UPDATER_CACHE_BEHAVIOR_TEMPLATES.map((template) =>
      buildCacheBehavior(template, {
        bucketName: options.bucketName,
        functionArn: options.functionArn,
        originRequestPolicyId: options.originRequestPolicyId,
      }),
    ),
  },
});

export const applyDistributionConfigOverrides = (
  distributionConfig: DistributionConfig,
  overrides: DistributionConfigOverrides,
): DistributionConfig => {
  return sanitizeDistributionConfig({
    ...distributionConfig,
    Origins: {
      Quantity: overrides.Origins.Quantity,
      Items: (overrides.Origins.Items ?? []).map((overrideOrigin) => {
        const existingOrigin = (distributionConfig.Origins?.Items ?? []).find(
          (origin) =>
            origin.Id === overrideOrigin.Id ||
            origin.DomainName === overrideOrigin.DomainName,
        );

        return mergeOriginWithExisting(existingOrigin, overrideOrigin);
      }),
    },
    DefaultCacheBehavior: mergeBehaviorWithExisting(
      distributionConfig.DefaultCacheBehavior,
      overrides.DefaultCacheBehavior,
    ),
    CacheBehaviors: {
      Quantity: overrides.CacheBehaviors.Quantity,
      Items: (overrides.CacheBehaviors.Items ?? []).map((overrideBehavior) => {
        const existingBehavior = (
          distributionConfig.CacheBehaviors?.Items ?? []
        ).find(
          (behavior) => behavior.PathPattern === overrideBehavior.PathPattern,
        );

        return mergeBehaviorWithExisting(existingBehavior, overrideBehavior);
      }),
    },
  });
};

export const buildDistributionConfig = (options: {
  bucketName: string;
  bucketDomain: string;
  functionArn: string;
  keyGroupId: string;
  oacId: string;
  originRequestPolicyId: string;
}): DistributionConfig =>
  sanitizeDistributionConfig({
    CallerReference: new Date().toISOString(),
    Comment: "Hot Updater CloudFront distribution",
    Enabled: true,
    ...buildDistributionConfigOverrides(options),
    DefaultRootObject: "index.html",
    ViewerCertificate: { CloudFrontDefaultCertificate: true },
    Restrictions: {
      GeoRestriction: { RestrictionType: "none", Quantity: 0 },
    },
    PriceClass: "PriceClass_All",
    Aliases: { Quantity: 0, Items: [] },
  });
