import type { DistributionConfig, Origin } from "@aws-sdk/client-cloudfront";
import { describe, expect, it } from "vitest";

import {
  applyDistributionConfigOverrides,
  buildDistributionConfig,
  buildDistributionConfigOverrides,
  HOT_UPDATER_SHARED_CACHE_POLICY_CONFIG,
  HOT_UPDATER_ORIGIN_REQUEST_POLICY_CONFIG,
} from "./cloudfrontDistributionConfig";

const baseOptions = {
  bucketName: "hot-updater-bucket",
  bucketDomain: "hot-updater-bucket.s3.ap-northeast-2.amazonaws.com",
  functionArn: "arn:aws:lambda:us-east-1:123456789012:function:hot-updater:1",
  keyGroupId: "key-group-id",
  oacId: "origin-access-control-id",
  originRequestPolicyId: "origin-request-policy-id",
  sharedCachePolicyId: "shared-cache-policy-id",
};

describe("buildDistributionConfigOverrides", () => {
  it("defines a shared cache policy that does not forward viewer headers", () => {
    expect(HOT_UPDATER_SHARED_CACHE_POLICY_CONFIG).toMatchObject({
      DefaultTTL: 0,
      MaxTTL: 31_536_000,
      MinTTL: 0,
      ParametersInCacheKeyAndForwardedToOrigin: {
        HeadersConfig: {
          HeaderBehavior: "whitelist",
          Headers: {
            Quantity: 1,
            Items: ["hot-updater-sdk-version"],
          },
        },
        CookiesConfig: { CookieBehavior: "none" },
        QueryStringsConfig: { QueryStringBehavior: "none" },
      },
    });
  });

  it("forwards the SDK version and authentication headers to Lambda", () => {
    expect(HOT_UPDATER_ORIGIN_REQUEST_POLICY_CONFIG).toMatchObject({
      HeadersConfig: {
        HeaderBehavior: "whitelist",
        Headers: {
          Quantity: 3,
          Items: ["content-type", "hot-updater-sdk-version", "x-api-key"],
        },
      },
    });
  });

  it("uses cache policies instead of legacy settings", () => {
    const overrides = buildDistributionConfigOverrides(baseOptions);
    const defaultBehavior = overrides.DefaultCacheBehavior;
    const behaviorItems = overrides.CacheBehaviors.Items ?? [];
    const [cachedEndpointBehavior] = behaviorItems;

    if (!cachedEndpointBehavior) {
      throw new Error("Expected cache behaviors to be generated");
    }

    expect(defaultBehavior.CachePolicyId).toBe(baseOptions.sharedCachePolicyId);
    expect(overrides.Origins.Items?.[0]?.CustomHeaders).toEqual({
      Quantity: 0,
    });
    expect(overrides.DefaultCacheBehavior.LambdaFunctionAssociations).toEqual({
      Quantity: 0,
    });
    expect(overrides.DefaultCacheBehavior.FunctionAssociations).toEqual({
      Quantity: 0,
    });
    expect("ForwardedValues" in defaultBehavior).toBe(false);
    expect("MinTTL" in defaultBehavior).toBe(false);
    expect("DefaultTTL" in defaultBehavior).toBe(false);
    expect("MaxTTL" in defaultBehavior).toBe(false);

    expect(cachedEndpointBehavior.PathPattern).toBe("/api/check-update/*");
    expect(cachedEndpointBehavior.CachePolicyId).toBe(
      baseOptions.sharedCachePolicyId,
    );
    expect(cachedEndpointBehavior.OriginRequestPolicyId).toBe(
      baseOptions.originRequestPolicyId,
    );
    expect(cachedEndpointBehavior.AllowedMethods).toMatchObject({
      Quantity: 7,
      Items: ["HEAD", "DELETE", "POST", "GET", "OPTIONS", "PUT", "PATCH"],
      CachedMethods: { Quantity: 2, Items: ["HEAD", "GET"] },
    });
    expect(cachedEndpointBehavior.FunctionAssociations).toEqual({
      Quantity: 0,
    });
    expect(
      cachedEndpointBehavior.LambdaFunctionAssociations?.Items?.[0]?.EventType,
    ).toBe("origin-request");
    expect(
      cachedEndpointBehavior.LambdaFunctionAssociations?.Items?.[0]
        ?.IncludeBody,
    ).toBe(true);
    expect("ForwardedValues" in cachedEndpointBehavior).toBe(false);
    expect("MinTTL" in cachedEndpointBehavior).toBe(false);
    expect("DefaultTTL" in cachedEndpointBehavior).toBe(false);
    expect("MaxTTL" in cachedEndpointBehavior).toBe(false);
  });

  it("replaces legacy fields when applying overrides to an existing distribution", () => {
    const overrides = buildDistributionConfigOverrides(baseOptions);
    const defaultBehavior = overrides.DefaultCacheBehavior;
    const behaviorItems = overrides.CacheBehaviors.Items ?? [];
    const [cachedEndpointBehavior] = behaviorItems;

    if (!cachedEndpointBehavior) {
      throw new Error("Expected cache behaviors to be generated");
    }

    const existingDistributionConfig: DistributionConfig = {
      ...buildDistributionConfig(baseOptions),
      DefaultCacheBehavior: {
        ...defaultBehavior,
        ForwardedValues: {
          QueryString: true,
          Cookies: { Forward: "none" },
        },
        MinTTL: 0,
        LambdaFunctionAssociations: {
          Quantity: 1,
          Items: [
            {
              EventType: "viewer-request",
              LambdaFunctionARN:
                "arn:aws:lambda:us-east-1:123456789012:function:default-behavior:1",
            },
          ],
        },
      },
      CacheBehaviors: {
        Quantity: 1,
        Items: [
          {
            ...cachedEndpointBehavior,
            ForwardedValues: {
              QueryString: false,
              Cookies: { Forward: "none" },
            },
            MinTTL: 0,
            DefaultTTL: 31536000,
            MaxTTL: 31536000,
          },
        ],
      },
      Origins: {
        Quantity: 1,
        Items: [
          {
            ...buildDistributionConfig(baseOptions).Origins!.Items![0]!,
            CustomHeaders: {
              Quantity: 1,
              Items: [
                {
                  HeaderName: "x-test-origin-header",
                  HeaderValue: "hot-updater",
                },
              ],
            },
          },
        ],
      },
    };

    const updatedConfig = applyDistributionConfigOverrides(
      existingDistributionConfig,
      overrides,
    );
    const updatedDefaultBehavior = updatedConfig.DefaultCacheBehavior!;
    const updatedBehaviorItems = updatedConfig.CacheBehaviors!.Items ?? [];

    expect(updatedConfig.Comment).toBe("Hot Updater CloudFront distribution");
    expect(updatedDefaultBehavior).toEqual(defaultBehavior);
    expect(updatedDefaultBehavior.LambdaFunctionAssociations).toEqual({
      Quantity: 0,
    });
    expect(updatedDefaultBehavior.FunctionAssociations).toEqual({
      Quantity: 0,
    });
    expect(updatedConfig.Origins?.Items?.[0]?.CustomHeaders).toEqual({
      Quantity: 1,
      Items: [
        {
          HeaderName: "x-test-origin-header",
          HeaderValue: "hot-updater",
        },
      ],
    });
    expect("ForwardedValues" in updatedDefaultBehavior).toBe(false);
    expect("MinTTL" in updatedDefaultBehavior).toBe(false);

    expect(updatedBehaviorItems[0]).toEqual(cachedEndpointBehavior);
    expect("ForwardedValues" in (updatedBehaviorItems[0] as object)).toBe(
      false,
    );
    expect("MinTTL" in (updatedBehaviorItems[0] as object)).toBe(false);
    expect("DefaultTTL" in (updatedBehaviorItems[0] as object)).toBe(false);
    expect("MaxTTL" in (updatedBehaviorItems[0] as object)).toBe(false);
  });

  it("preserves unrelated origins and cache behaviors on an existing distribution", () => {
    // Given
    const overrides = buildDistributionConfigOverrides(baseOptions);
    const existingDistributionConfig: DistributionConfig = {
      ...buildDistributionConfig(baseOptions),
      Origins: {
        Quantity: 2,
        Items: [
          ...(buildDistributionConfig(baseOptions).Origins?.Items ?? []),
          {
            Id: "unrelated-origin",
            DomainName: "example.com",
            CustomOriginConfig: {
              HTTPPort: 80,
              HTTPSPort: 443,
              OriginProtocolPolicy: "https-only",
            },
          },
        ],
      },
      CacheBehaviors: {
        Quantity: 2,
        Items: [
          ...(buildDistributionConfig(baseOptions).CacheBehaviors?.Items ?? []),
          {
            AllowedMethods: {
              Quantity: 2,
              Items: ["HEAD", "GET"],
              CachedMethods: { Quantity: 2, Items: ["HEAD", "GET"] },
            },
            CachePolicyId: "unrelated-cache-policy-id",
            Compress: true,
            PathPattern: "/unrelated/*",
            SmoothStreaming: false,
            TargetOriginId: "unrelated-origin",
            ViewerProtocolPolicy: "redirect-to-https",
          },
        ],
      },
    };

    // When
    const updatedConfig = applyDistributionConfigOverrides(
      existingDistributionConfig,
      overrides,
    );

    // Then
    expect(updatedConfig.Origins?.Items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Id: baseOptions.bucketName }),
        expect.objectContaining({ Id: "unrelated-origin" }),
      ]),
    );
    expect(updatedConfig.CacheBehaviors?.Items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ PathPattern: "/api/check-update/*" }),
        expect.objectContaining({ PathPattern: "/unrelated/*" }),
      ]),
    );
  });

  it("preserves the existing managed origin id referenced by other behaviors", () => {
    // Given
    const overrides = buildDistributionConfigOverrides(baseOptions);
    const existingOriginId = "preexisting-bucket-origin";
    const existingDistributionConfig: DistributionConfig = {
      ...buildDistributionConfig(baseOptions),
      Origins: {
        Quantity: 1,
        Items: [
          {
            ...(buildDistributionConfig(baseOptions).Origins
              ?.Items?.[0] as Origin),
            Id: existingOriginId,
          },
        ],
      },
      CacheBehaviors: {
        Quantity: 1,
        Items: [
          {
            AllowedMethods: {
              Quantity: 2,
              Items: ["HEAD", "GET"],
              CachedMethods: { Quantity: 2, Items: ["HEAD", "GET"] },
            },
            CachePolicyId: "assets-cache-policy-id",
            Compress: true,
            PathPattern: "/assets/*",
            SmoothStreaming: false,
            TargetOriginId: existingOriginId,
            ViewerProtocolPolicy: "redirect-to-https",
          },
        ],
      },
    };

    // When
    const updatedConfig = applyDistributionConfigOverrides(
      existingDistributionConfig,
      overrides,
    );

    // Then
    expect(updatedConfig.Origins?.Items?.map(({ Id }) => Id)).toEqual([
      existingOriginId,
    ]);
    expect(updatedConfig.DefaultCacheBehavior?.TargetOriginId).toBe(
      existingOriginId,
    );
    expect(
      updatedConfig.CacheBehaviors?.Items?.map(
        ({ TargetOriginId }) => TargetOriginId,
      ),
    ).toEqual([existingOriginId, existingOriginId]);
  });

  it("places a new update API behavior before broader existing behaviors", () => {
    // Given
    const overrides = buildDistributionConfigOverrides(baseOptions);
    const existingDistributionConfig: DistributionConfig = {
      ...buildDistributionConfig(baseOptions),
      CacheBehaviors: {
        Quantity: 1,
        Items: [
          {
            AllowedMethods: {
              Quantity: 2,
              Items: ["HEAD", "GET"],
              CachedMethods: { Quantity: 2, Items: ["HEAD", "GET"] },
            },
            CachePolicyId: "existing-cache-policy-id",
            Compress: true,
            PathPattern: "/api/*",
            SmoothStreaming: false,
            TargetOriginId: baseOptions.bucketName,
            ViewerProtocolPolicy: "redirect-to-https",
          },
        ],
      },
    };

    // When
    const updatedConfig = applyDistributionConfigOverrides(
      existingDistributionConfig,
      overrides,
    );

    // Then
    expect(
      updatedConfig.CacheBehaviors?.Items?.map(
        ({ PathPattern }) => PathPattern,
      ),
    ).toEqual(["/api/check-update/*", "/api/*"]);
  });

  it("keeps narrower existing behaviors before the update API behavior", () => {
    // Given
    const overrides = buildDistributionConfigOverrides(baseOptions);
    const existingDistributionConfig: DistributionConfig = {
      ...buildDistributionConfig(baseOptions),
      CacheBehaviors: {
        Quantity: 2,
        Items: [
          {
            AllowedMethods: {
              Quantity: 2,
              Items: ["HEAD", "GET"],
              CachedMethods: { Quantity: 2, Items: ["HEAD", "GET"] },
            },
            CachePolicyId: "private-cache-policy-id",
            Compress: true,
            PathPattern: "/api/check-update/private/*",
            SmoothStreaming: false,
            TargetOriginId: baseOptions.bucketName,
            ViewerProtocolPolicy: "redirect-to-https",
          },
          {
            AllowedMethods: {
              Quantity: 2,
              Items: ["HEAD", "GET"],
              CachedMethods: { Quantity: 2, Items: ["HEAD", "GET"] },
            },
            CachePolicyId: "api-cache-policy-id",
            Compress: true,
            PathPattern: "/api/*",
            SmoothStreaming: false,
            TargetOriginId: baseOptions.bucketName,
            ViewerProtocolPolicy: "redirect-to-https",
          },
        ],
      },
    };

    // When
    const updatedConfig = applyDistributionConfigOverrides(
      existingDistributionConfig,
      overrides,
    );

    // Then
    expect(
      updatedConfig.CacheBehaviors?.Items?.map(
        ({ PathPattern }) => PathPattern,
      ),
    ).toEqual(["/api/check-update/private/*", "/api/check-update/*", "/api/*"]);
  });
});
