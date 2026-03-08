import type { DistributionConfig } from "@aws-sdk/client-cloudfront";
import { describe, expect, it } from "vitest";
import {
  applyDistributionConfigOverrides,
  buildDistributionConfig,
  buildDistributionConfigOverrides,
  HOT_UPDATER_LEGACY_CHECK_UPDATE_CACHE_POLICY_CONFIG,
  HOT_UPDATER_LEGACY_CHECK_UPDATE_HEADERS,
  HOT_UPDATER_MANAGED_CACHE_POLICY_IDS,
  HOT_UPDATER_SHARED_CACHE_POLICY_CONFIG,
} from "./cloudfrontDistributionConfig";

const baseOptions = {
  bucketName: "hot-updater-bucket",
  bucketDomain: "hot-updater-bucket.s3.ap-northeast-2.amazonaws.com",
  functionArn: "arn:aws:lambda:us-east-1:123456789012:function:hot-updater:1",
  keyGroupId: "key-group-id",
  oacId: "origin-access-control-id",
  legacyCachePolicyId: "legacy-cache-policy-id",
  sharedCachePolicyId: "shared-cache-policy-id",
};

describe("buildDistributionConfigOverrides", () => {
  it("defines a shared cache policy that does not forward viewer headers", () => {
    expect(HOT_UPDATER_SHARED_CACHE_POLICY_CONFIG).toMatchObject({
      DefaultTTL: 0,
      MaxTTL: 31_536_000,
      MinTTL: 0,
      ParametersInCacheKeyAndForwardedToOrigin: {
        HeadersConfig: { HeaderBehavior: "none" },
        CookiesConfig: { CookieBehavior: "none" },
        QueryStringsConfig: { QueryStringBehavior: "none" },
      },
    });
  });

  it("uses cache policies instead of legacy settings", () => {
    const overrides = buildDistributionConfigOverrides(baseOptions);
    const defaultBehavior = overrides.DefaultCacheBehavior;
    const behaviorItems = overrides.CacheBehaviors.Items ?? [];
    const [legacyEndpointBehavior, cachedEndpointBehavior] = behaviorItems;

    if (!legacyEndpointBehavior || !cachedEndpointBehavior) {
      throw new Error("Expected cache behaviors to be generated");
    }

    expect(HOT_UPDATER_LEGACY_CHECK_UPDATE_CACHE_POLICY_CONFIG).toMatchObject({
      DefaultTTL: 0,
      MaxTTL: 0,
      MinTTL: 0,
      ParametersInCacheKeyAndForwardedToOrigin: {
        HeadersConfig: {
          HeaderBehavior: "whitelist",
          Headers: {
            Quantity: HOT_UPDATER_LEGACY_CHECK_UPDATE_HEADERS.length,
            Items: [...HOT_UPDATER_LEGACY_CHECK_UPDATE_HEADERS],
          },
        },
        CookiesConfig: { CookieBehavior: "none" },
        QueryStringsConfig: { QueryStringBehavior: "none" },
      },
    });

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

    expect(legacyEndpointBehavior.PathPattern).toBe("/api/check-update");
    expect(legacyEndpointBehavior.CachePolicyId).toBe(
      baseOptions.legacyCachePolicyId,
    );
    expect(legacyEndpointBehavior.FunctionAssociations).toEqual({
      Quantity: 0,
    });
    expect(
      legacyEndpointBehavior.LambdaFunctionAssociations?.Items?.[0]?.EventType,
    ).toBe("origin-request");
    expect("ForwardedValues" in legacyEndpointBehavior).toBe(false);
    expect("MinTTL" in legacyEndpointBehavior).toBe(false);
    expect("DefaultTTL" in legacyEndpointBehavior).toBe(false);
    expect("MaxTTL" in legacyEndpointBehavior).toBe(false);

    expect(cachedEndpointBehavior.PathPattern).toBe("/api/check-update/*");
    expect(cachedEndpointBehavior.CachePolicyId).toBe(
      baseOptions.sharedCachePolicyId,
    );
    expect(cachedEndpointBehavior.FunctionAssociations).toEqual({
      Quantity: 0,
    });
    expect(
      cachedEndpointBehavior.LambdaFunctionAssociations?.Items?.[0]?.EventType,
    ).toBe("origin-request");
    expect("ForwardedValues" in cachedEndpointBehavior).toBe(false);
    expect("MinTTL" in cachedEndpointBehavior).toBe(false);
    expect("DefaultTTL" in cachedEndpointBehavior).toBe(false);
    expect("MaxTTL" in cachedEndpointBehavior).toBe(false);
  });

  it("replaces legacy fields when applying overrides to an existing distribution", () => {
    const overrides = buildDistributionConfigOverrides(baseOptions);
    const defaultBehavior = overrides.DefaultCacheBehavior;
    const behaviorItems = overrides.CacheBehaviors.Items ?? [];
    const [legacyEndpointBehavior, cachedEndpointBehavior] = behaviorItems;

    if (!legacyEndpointBehavior || !cachedEndpointBehavior) {
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
        Quantity: 2,
        Items: [
          {
            ...legacyEndpointBehavior,
            ForwardedValues: {
              QueryString: false,
              Cookies: { Forward: "none" },
            },
            MinTTL: 0,
            DefaultTTL: 0,
            MaxTTL: 0,
          },
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

    expect(updatedBehaviorItems[0]).toEqual(legacyEndpointBehavior);
    expect(updatedBehaviorItems[1]).toEqual(cachedEndpointBehavior);
    expect("ForwardedValues" in (updatedBehaviorItems[0] as object)).toBe(
      false,
    );
    expect("ForwardedValues" in (updatedBehaviorItems[1] as object)).toBe(
      false,
    );
    expect("MinTTL" in (updatedBehaviorItems[0] as object)).toBe(false);
    expect("DefaultTTL" in (updatedBehaviorItems[1] as object)).toBe(false);
    expect("MaxTTL" in (updatedBehaviorItems[1] as object)).toBe(false);
  });
});
