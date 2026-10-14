import { SSM } from "@aws-sdk/client-ssm";
import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import {
  BUNDLE_STORAGE_PREFIX,
  CONTENT_ADDRESSED_ASSET_PREFIX,
} from "@hot-updater/plugin-core";

import { applySsmRuntimeAwsConfig } from "./runtimeAwsConfig";

const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365;

/** Signatures kept per process; one per Bundle plus one for shared assets. */
const MAX_CACHED_SIGNATURES = 1000;

interface CloudFrontPrivateKeyFromGetter {
  getPrivateKey: () => Promise<string>;
  ssmParameterName?: never;
  ssmRegion?: never;
}

interface CloudFrontPrivateKeyFromSsm {
  getPrivateKey?: never;
  ssmParameterName: string;
  ssmRegion: string;
}

export type CloudFrontDownloadUrlOptions = (
  | CloudFrontPrivateKeyFromGetter
  | CloudFrontPrivateKeyFromSsm
) & {
  keyPairId: string;
  publicBaseUrl: string;
  expiresSeconds?: number;
};

const privateKeyCache = new Map<string, Promise<string>>();

const getPrivateKeyFromSsm = async (region: string, parameterName: string) => {
  const response = await new SSM(
    applySsmRuntimeAwsConfig({ region }),
  ).getParameter({ Name: parameterName, WithDecryption: true });
  const value = response.Parameter?.Value;
  if (!value) {
    throw new Error(`CloudFront private key is missing: ${parameterName}`);
  }

  const privateKey = (JSON.parse(value) as { privateKey?: unknown }).privateKey;
  if (typeof privateKey !== "string" || privateKey.length === 0) {
    throw new Error(`Invalid CloudFront private key: ${parameterName}`);
  }
  return privateKey;
};

const resolvePrivateKey = (config: CloudFrontDownloadUrlOptions) => {
  if (config.getPrivateKey) return config.getPrivateKey();

  const cacheKey = `${config.ssmRegion}:${config.ssmParameterName}`;
  const cached = privateKeyCache.get(cacheKey);
  if (cached) return cached;

  const pending = getPrivateKeyFromSsm(
    config.ssmRegion,
    config.ssmParameterName,
  ).catch((error) => {
    privateKeyCache.delete(cacheKey);
    throw error;
  });
  privateKeyCache.set(cacheKey, pending);
  return pending;
};

/**
 * The URL path one signature covers: every file of one Bundle
 * (`bundles/<bundleId>/*`), or every content-addressed asset (`assets/*`),
 * whose SHA-256 names cannot be listed without a manifest that names them.
 * Any other object is signed alone.
 */
const getSignedPathScope = (pathname: string) => {
  const segments = pathname.split("/");
  const assets = segments.length - 4;
  if (
    segments[assets] === CONTENT_ADDRESSED_ASSET_PREFIX &&
    segments[assets + 1] === "sha256"
  ) {
    return `${segments.slice(0, assets + 1).join("/")}/*`;
  }
  const bundles = segments.lastIndexOf(BUNDLE_STORAGE_PREFIX);
  if (bundles >= 0 && segments.length - bundles > 2) {
    return `${segments.slice(0, bundles + 2).join("/")}/*`;
  }
  return pathname;
};

/**
 * Download URLs signed with a CloudFront key pair. An update check returns a
 * URL for every file of the Bundle, hundreds for an app with many assets, so
 * one custom-policy signature covers a Bundle's files and another the shared
 * assets: each is reused for every URL under it until half its lifetime has
 * passed, instead of one RSA signature per file.
 */
export const cloudFrontDownloadUrl = (config: CloudFrontDownloadUrlOptions) => {
  /** Signed query strings by policy resource, for this configuration only. */
  const signatureCache = new Map<
    string,
    { readonly query: string; readonly renewAt: number }
  >();

  return async ({ storageUri }: { storageUri: string }) => {
    const storageUrl = new URL(storageUri);
    if (storageUrl.protocol !== "s3:") {
      throw new Error("CloudFront download URLs require an s3 storage URI.");
    }

    const url = new URL(config.publicBaseUrl);
    url.pathname = storageUrl.pathname;
    url.search = "";
    url.hash = "";
    const resource = `${url.origin}${getSignedPathScope(url.pathname)}`;
    const cacheKey = resource;
    const privateKey = await resolvePrivateKey(config);

    // Nothing awaits from here on, so concurrent calls for one scope sign once.
    const cached = signatureCache.get(cacheKey);
    if (cached && Date.now() < cached.renewAt) {
      return { url: `${url}${cached.query}` };
    }

    const expiresSeconds = config.expiresSeconds ?? ONE_YEAR_IN_SECONDS;
    const signedAt = Date.now();
    const signedUrl = getSignedUrl({
      url: url.toString(),
      keyPairId: config.keyPairId,
      privateKey,
      policy: JSON.stringify({
        Statement: [
          {
            Resource: resource,
            Condition: {
              DateLessThan: {
                "AWS:EpochTime": Math.floor(
                  (signedAt + expiresSeconds * 1000) / 1000,
                ),
              },
            },
          },
        ],
      }),
    });
    const query = new URL(signedUrl).search;
    signatureCache.delete(cacheKey);
    signatureCache.set(cacheKey, {
      query,
      renewAt: signedAt + (expiresSeconds * 1000) / 2,
    });
    if (signatureCache.size > MAX_CACHED_SIGNATURES) {
      signatureCache.delete(signatureCache.keys().next().value!);
    }
    return { url: `${url}${query}` };
  };
};
