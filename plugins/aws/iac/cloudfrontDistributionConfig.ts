import type {
  AllowedMethods,
  CachePolicyConfig,
  DistributionConfig,
  Origin,
} from "@aws-sdk/client-cloudfront";

// We intentionally avoid the AWS-managed UseOriginCacheControlHeaders policy here.
// That managed policy forwards the viewer Host header and all cookies to the origin,
// which breaks S3 origins for bundle downloads and bloats the cache key unnecessarily.
export const HOT_UPDATER_SHARED_CACHE_POLICY_CONFIG: CachePolicyConfig = {
  Name: "HotUpdaterOriginCacheControl",
  Comment:
    "Honor origin Cache-Control without forwarding viewer Host/cookies/query strings",
  DefaultTTL: 0,
  MaxTTL: 31_536_000,
  MinTTL: 0,
  ParametersInCacheKeyAndForwardedToOrigin: {
    EnableAcceptEncodingBrotli: true,
    EnableAcceptEncodingGzip: true,
    HeadersConfig: {
      HeaderBehavior: "none",
    },
    CookiesConfig: {
      CookieBehavior: "none",
    },
    QueryStringsConfig: {
      QueryStringBehavior: "none",
    },
  },
};

export type DistributionConfigOverrides = {
  Origins: NonNullable<DistributionConfig["Origins"]>;
  DefaultCacheBehavior: NonNullable<DistributionConfig["DefaultCacheBehavior"]>;
  CacheBehaviors: NonNullable<DistributionConfig["CacheBehaviors"]>;
};

type DefaultBehavior = NonNullable<DistributionConfig["DefaultCacheBehavior"]>;
type CacheBehavior = NonNullable<
  NonNullable<DistributionConfig["CacheBehaviors"]>["Items"]
>[number];

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

const HOT_UPDATER_CACHE_BEHAVIOR_PATH = "/api/check-update/*";

const omitLegacyCacheFields = <
  T extends {
    ForwardedValues?: unknown;
    MinTTL?: unknown;
    DefaultTTL?: unknown;
    MaxTTL?: unknown;
    OriginRequestPolicyId?: unknown;
  },
>(
  value: T,
) => {
  const {
    ForwardedValues: _forwardedValues,
    MinTTL: _minTTL,
    DefaultTTL: _defaultTTL,
    MaxTTL: _maxTTL,
    OriginRequestPolicyId: _originRequestPolicyId,
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
  sharedCachePolicyId: string;
}): DefaultBehavior => ({
  ...buildSharedBehavior(options.bucketName),
  TrustedKeyGroups: {
    Enabled: true,
    Quantity: 1,
    Items: [options.keyGroupId],
  },
  CachePolicyId: options.sharedCachePolicyId,
  LambdaFunctionAssociations: EMPTY_LAMBDA_FUNCTION_ASSOCIATIONS,
});

const buildCacheBehavior = (options: {
  bucketName: string;
  functionArn: string;
  sharedCachePolicyId: string;
}): CacheBehavior => ({
  ...buildSharedBehavior(options.bucketName),
  PathPattern: HOT_UPDATER_CACHE_BEHAVIOR_PATH,
  CachePolicyId: options.sharedCachePolicyId,
  LambdaFunctionAssociations: buildOriginRequestLambdaAssociations(
    options.functionArn,
  ),
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
  sharedCachePolicyId: string;
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
    sharedCachePolicyId: options.sharedCachePolicyId,
  }),
  CacheBehaviors: {
    Quantity: 1,
    Items: [
      buildCacheBehavior({
        bucketName: options.bucketName,
        functionArn: options.functionArn,
        sharedCachePolicyId: options.sharedCachePolicyId,
      }),
    ],
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
  sharedCachePolicyId: string;
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
