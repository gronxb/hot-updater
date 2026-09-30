import type {
  AllowedMethods,
  CachePolicyConfig,
  DistributionConfig,
  Origin,
  OriginRequestPolicyConfig,
} from "@aws-sdk/client-cloudfront";

/**
 * The request headers a cache key holds: those the server's client-route
 * policy reads, so responses to different credentials never share an entry.
 */
const headersConfig = (
  clientHeaders: readonly string[],
): NonNullable<
  NonNullable<
    CachePolicyConfig["ParametersInCacheKeyAndForwardedToOrigin"]
  >["HeadersConfig"]
> =>
  clientHeaders.length === 0
    ? { HeaderBehavior: "none" }
    : {
        HeaderBehavior: "whitelist",
        Headers: { Quantity: clientHeaders.length, Items: [...clientHeaders] },
      };

// We intentionally avoid the AWS-managed UseOriginCacheControlHeaders policy here.
// That managed policy forwards the viewer Host header and all cookies to the origin,
// which breaks S3 origins and bloats the cache key beyond the client-route headers.
export const buildSharedCachePolicyConfig = (
  clientHeaders: readonly string[],
): CachePolicyConfig => ({
  Name: "HotUpdaterOriginCacheControlV2",
  Comment:
    "Honor origin Cache-Control without forwarding viewer Host/cookies/query strings",
  DefaultTTL: 0,
  MaxTTL: 31_536_000,
  MinTTL: 0,
  ParametersInCacheKeyAndForwardedToOrigin: {
    EnableAcceptEncodingBrotli: true,
    EnableAcceptEncodingGzip: true,
    HeadersConfig: headersConfig(clientHeaders),
    CookiesConfig: {
      CookieBehavior: "none",
    },
    QueryStringsConfig: {
      QueryStringBehavior: "none",
    },
  },
});

export const buildReleaseCatalogCachePolicyConfig = (
  clientHeaders: readonly string[],
): CachePolicyConfig => ({
  Name: "HotUpdaterReleaseCatalogV1",
  Comment:
    "Cache Release catalogs by canonical path, client credential, and encoding",
  DefaultTTL: 0,
  MaxTTL: 5,
  MinTTL: 0,
  ParametersInCacheKeyAndForwardedToOrigin: {
    EnableAcceptEncodingBrotli: true,
    EnableAcceptEncodingGzip: true,
    HeadersConfig: headersConfig(clientHeaders),
    CookiesConfig: { CookieBehavior: "none" },
    QueryStringsConfig: { QueryStringBehavior: "none" },
  },
});

export const buildOriginRequestPolicyConfig = (
  clientHeaders: readonly string[],
): OriginRequestPolicyConfig => ({
  Name: "HotUpdaterManagedApiOriginRequestV2",
  Comment:
    "Forward managed API bodies, query strings, and the client credential",
  HeadersConfig: {
    HeaderBehavior: "whitelist",
    Headers: {
      Quantity: clientHeaders.length + 1,
      Items: ["content-type", ...clientHeaders],
    },
  },
  CookiesConfig: { CookieBehavior: "none" },
  QueryStringsConfig: { QueryStringBehavior: "all" },
});

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

const API_METHODS: AllowedMethods = {
  Quantity: 7,
  Items: ["HEAD", "DELETE", "POST", "GET", "OPTIONS", "PUT", "PATCH"],
  CachedMethods: READ_ONLY_METHODS.CachedMethods,
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

export const HOT_UPDATER_CACHE_BEHAVIOR_PATHS = [
  "/events",
  "/artifacts/*",
  "/version",
] as const;

export const HOT_UPDATER_RELEASE_CATALOG_BEHAVIOR_PATHS = [
  "/release-catalogs/*",
] as const;

/** The bucket's prefixes, which the default behavior serves from S3. */
const STORAGE_PATH_SEGMENTS = new Set(["bundles", "assets"]);

/** Whether a request to `pattern` already goes where one of `patterns` sends it. */
const isCoveredBy = (patterns: readonly string[], pattern: string) =>
  patterns.some(
    (candidate) =>
      candidate === pattern ||
      (candidate.endsWith("/*") && pattern.startsWith(candidate.slice(0, -1))),
  );

/**
 * The path patterns that send the plugins' client endpoints to the
 * Lambda@Edge function, beyond the managed server's own: each endpoint's
 * path up to its first parameter, then `*`. A path under the bucket's
 * `bundles` or `assets`, or one that would take every path, is refused,
 * since CloudFront serves the bundles from S3 there.
 */
export const pluginCacheBehaviorPaths = (
  endpoints: readonly { readonly plugin: string; readonly path: string }[],
): string[] => {
  const paths: string[] = [];
  for (const { plugin, path } of endpoints) {
    const segments = (path.startsWith("/") ? path : `/${path}`).split("/");
    const parameter = segments.findIndex(
      (segment) => segment.startsWith(":") || segment.includes("*"),
    );
    const pattern =
      parameter === -1
        ? segments.join("/")
        : `${segments.slice(0, parameter).join("/")}/*`;
    if (
      isCoveredBy(
        [
          ...HOT_UPDATER_RELEASE_CATALOG_BEHAVIOR_PATHS,
          ...HOT_UPDATER_CACHE_BEHAVIOR_PATHS,
          ...paths,
        ],
        pattern,
      )
    ) {
      continue;
    }
    if (pattern === "/*" || STORAGE_PATH_SEGMENTS.has(segments[1] ?? "")) {
      throw new Error(
        `Plugin "${plugin}" serves ${path}, but the managed AWS server's CloudFront distribution serves bundles from S3 there. Move the plugin's endpoint, or host the server yourself.`,
      );
    }
    paths.push(pattern);
  }
  return paths;
};

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
      IncludeBody: true,
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
  originRequestPolicyId: string;
  pathPattern: string;
  sharedCachePolicyId: string;
}): CacheBehavior => ({
  ...buildSharedBehavior(options.bucketName),
  AllowedMethods: API_METHODS,
  PathPattern: options.pathPattern,
  CachePolicyId: options.sharedCachePolicyId,
  OriginRequestPolicyId: options.originRequestPolicyId,
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
  Id: existingOrigin?.Id ?? overrideOrigin.Id,
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

const mergeOrigins = (
  existing: readonly Origin[],
  overrides: readonly Origin[],
): Origin[] => [
  ...existing.map((existingOrigin) => {
    const override = overrides.find(
      (candidate) =>
        candidate.Id === existingOrigin.Id ||
        candidate.DomainName === existingOrigin.DomainName,
    );
    return override
      ? mergeOriginWithExisting(existingOrigin, override)
      : existingOrigin;
  }),
  ...overrides.filter(
    (override) =>
      !existing.some(
        (candidate) =>
          candidate.Id === override.Id ||
          candidate.DomainName === override.DomainName,
      ),
  ),
];

const mergeCacheBehaviors = (
  existing: readonly CacheBehavior[],
  overrides: readonly CacheBehavior[],
): CacheBehavior[] => {
  const additions = overrides.filter(
    (override) =>
      !existing.some(
        (candidate) => candidate.PathPattern === override.PathPattern,
      ),
  );
  const mergedExisting = existing.map((existingBehavior) => {
    const override = overrides.find(
      (candidate) => candidate.PathPattern === existingBehavior.PathPattern,
    );
    return override
      ? mergeBehaviorWithExisting(existingBehavior, override)
      : existingBehavior;
  });
  return additions.reduce<CacheBehavior[]>((behaviors, addition) => {
    const additionPrefix =
      (addition.PathPattern ?? "").split(/[?*]/, 1)[0] ?? "";
    const broaderBehaviorIndex = behaviors.findIndex((behavior) => {
      const behaviorPattern = behavior.PathPattern ?? "";
      const wildcardIndex = behaviorPattern.indexOf("*");
      if (
        wildcardIndex !== behaviorPattern.length - 1 ||
        behaviorPattern.includes("?")
      ) {
        return false;
      }
      const behaviorPrefix = behaviorPattern.slice(0, wildcardIndex);
      return (
        behaviorPrefix.length < additionPrefix.length &&
        additionPrefix.startsWith(behaviorPrefix)
      );
    });
    if (broaderBehaviorIndex === -1) {
      return [...behaviors, addition];
    }
    return [
      ...behaviors.slice(0, broaderBehaviorIndex),
      addition,
      ...behaviors.slice(broaderBehaviorIndex),
    ];
  }, mergedExisting);
};

export const buildDistributionConfigOverrides = (options: {
  bucketName: string;
  bucketDomain: string;
  functionArn: string;
  keyGroupId: string;
  oacId: string;
  originRequestPolicyId: string;
  releaseCatalogCachePolicyId: string;
  sharedCachePolicyId: string;
  /** From `pluginCacheBehaviorPaths`: the plugins' client endpoints. */
  pluginPaths?: readonly string[];
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
    Quantity:
      HOT_UPDATER_RELEASE_CATALOG_BEHAVIOR_PATHS.length +
      HOT_UPDATER_CACHE_BEHAVIOR_PATHS.length +
      (options.pluginPaths?.length ?? 0),
    Items: [
      ...HOT_UPDATER_RELEASE_CATALOG_BEHAVIOR_PATHS.map((pathPattern) =>
        buildCacheBehavior({
          bucketName: options.bucketName,
          functionArn: options.functionArn,
          originRequestPolicyId: options.originRequestPolicyId,
          pathPattern,
          sharedCachePolicyId: options.releaseCatalogCachePolicyId,
        }),
      ),
      ...[
        ...HOT_UPDATER_CACHE_BEHAVIOR_PATHS,
        ...(options.pluginPaths ?? []),
      ].map((pathPattern) =>
        buildCacheBehavior({
          bucketName: options.bucketName,
          functionArn: options.functionArn,
          originRequestPolicyId: options.originRequestPolicyId,
          pathPattern,
          sharedCachePolicyId: options.sharedCachePolicyId,
        }),
      ),
    ],
  },
});

/** The functions a behavior sends requests to, whichever version it names. */
const functionsOf = (behavior: CacheBehavior) =>
  (behavior.LambdaFunctionAssociations?.Items ?? []).map(
    ({ LambdaFunctionARN = "" }) =>
      LambdaFunctionARN.split(":").slice(0, 7).join(":"),
  );

export const applyDistributionConfigOverrides = (
  distributionConfig: DistributionConfig,
  overrides: DistributionConfigOverrides,
): DistributionConfig => {
  const managedOrigin = overrides.Origins.Items?.[0];
  const existingManagedOrigin = managedOrigin
    ? distributionConfig.Origins?.Items?.find(
        (origin) =>
          origin.Id === managedOrigin.Id ||
          origin.DomainName === managedOrigin.DomainName,
      )
    : undefined;
  const targetOriginId = existingManagedOrigin?.Id ?? managedOrigin?.Id;
  const defaultCacheBehavior = targetOriginId
    ? { ...overrides.DefaultCacheBehavior, TargetOriginId: targetOriginId }
    : overrides.DefaultCacheBehavior;
  const cacheBehaviorOverrides = (overrides.CacheBehaviors.Items ?? []).map(
    (behavior) =>
      targetOriginId
        ? { ...behavior, TargetOriginId: targetOriginId }
        : behavior,
  );
  const origins = mergeOrigins(
    distributionConfig.Origins?.Items ?? [],
    overrides.Origins.Items ?? [],
  );
  // A path the managed function served that this deploy no longer routes,
  // such as a removed plugin's endpoint, stops reaching its old version.
  const managedFunctions = new Set(cacheBehaviorOverrides.flatMap(functionsOf));
  const routedPaths = new Set(
    cacheBehaviorOverrides.map(({ PathPattern }) => PathPattern),
  );
  const cacheBehaviors = mergeCacheBehaviors(
    (distributionConfig.CacheBehaviors?.Items ?? []).filter(
      (behavior) =>
        routedPaths.has(behavior.PathPattern) ||
        !functionsOf(behavior).some((name) => managedFunctions.has(name)),
    ),
    cacheBehaviorOverrides,
  );
  return sanitizeDistributionConfig({
    ...distributionConfig,
    Origins: {
      Quantity: origins.length,
      Items: origins,
    },
    DefaultCacheBehavior: mergeBehaviorWithExisting(
      distributionConfig.DefaultCacheBehavior,
      defaultCacheBehavior,
    ),
    CacheBehaviors: {
      Quantity: cacheBehaviors.length,
      Items: cacheBehaviors,
    },
  });
};

export const buildDistributionConfig = (
  options: Parameters<typeof buildDistributionConfigOverrides>[0],
): DistributionConfig =>
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
