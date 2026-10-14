import { createVerify, generateKeyPairSync } from "node:crypto";

import { SSM } from "@aws-sdk/client-ssm";
import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cloudFrontDownloadUrl } from "./cloudFrontDownloadUrl";

vi.mock("@aws-sdk/cloudfront-signer", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@aws-sdk/cloudfront-signer")>();
  return { ...actual, getSignedUrl: vi.fn(actual.getSignedUrl) };
});

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/** CloudFront's URL-safe base64: `+` → `-`, `=` → `_`, `/` → `~`. */
const fromCloudFrontBase64 = (value: string) =>
  Buffer.from(
    value.replaceAll("-", "+").replaceAll("_", "=").replaceAll("~", "/"),
    "base64",
  );

/** The policy a signed URL carries, after checking its signature. */
const readVerifiedPolicy = (signedUrl: string) => {
  const { searchParams } = new URL(signedUrl);
  const policy = fromCloudFrontBase64(searchParams.get("Policy")!);
  const signature = fromCloudFrontBase64(searchParams.get("Signature")!);
  const verifier = createVerify("RSA-SHA1");
  verifier.update(policy);
  expect(verifier.verify(publicKey, signature)).toBe(true);
  expect(searchParams.get("Key-Pair-Id")).toBe("K123");
  return JSON.parse(policy.toString("utf8")) as {
    Statement: {
      Resource: string;
      Condition: { DateLessThan: { "AWS:EpochTime": number } };
    }[];
  };
};

const assetUri = (index: number) => {
  const hash = index.toString(16).padStart(64, "0");
  return `s3://test-bucket/production/assets/sha256/${hash.slice(0, 2)}/${hash}.png`;
};

let distribution = 0;
/** Signatures are reused per distribution, so each test gets its own. */
const nextPublicBaseUrl = () =>
  `https://d${(distribution += 1)}.cloudfront.net`;

describe("cloudFrontDownloadUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves an S3 URI through the configured CloudFront origin", async () => {
    const publicBaseUrl = nextPublicBaseUrl();
    const getDownloadUrl = cloudFrontDownloadUrl({
      keyPairId: "K123",
      getPrivateKey: async () => privateKey,
      publicBaseUrl,
      expiresSeconds: 60,
    });

    const { url } = await getDownloadUrl({
      storageUri: "s3://test-bucket/releases/bundle.zip",
    });

    expect(`${new URL(url).origin}${new URL(url).pathname}`).toBe(
      `${publicBaseUrl}/releases/bundle.zip`,
    );
    const [statement] = readVerifiedPolicy(url).Statement;
    expect(statement!.Resource).toBe(`${publicBaseUrl}/releases/bundle.zip`);
    expect(
      statement!.Condition.DateLessThan["AWS:EpochTime"] * 1000 - Date.now(),
    ).toBeLessThanOrEqual(60_000);
  });

  it("signs once for a bundle's files and once for every shared asset", async () => {
    const publicBaseUrl = nextPublicBaseUrl();
    const getPrivateKey = vi.fn(async () => privateKey);
    const getDownloadUrl = cloudFrontDownloadUrl({
      keyPairId: "K123",
      getPrivateKey,
      publicBaseUrl,
    });
    const bundleUris = [
      "s3://test-bucket/production/bundles/0199-bundle/manifest.json",
      "s3://test-bucket/production/bundles/0199-bundle/bundle.tar.br",
      "s3://test-bucket/production/bundles/0199-bundle/patches/0198-base/abc/index.android.bundle.bsdiff",
    ];
    const assetUris = Array.from({ length: 650 }, (_, index) =>
      assetUri(index),
    );

    // One artifact response resolves every URL at once.
    const urls = await Promise.all(
      [...bundleUris, ...assetUris].map(
        async (storageUri) => (await getDownloadUrl({ storageUri })).url,
      ),
    );

    expect(getSignedUrl).toHaveBeenCalledTimes(2);
    // A secret store is asked once per signature, not once per URL.
    expect(getPrivateKey).toHaveBeenCalledTimes(2);
    const [bundleUrls, assetUrls] = [urls.slice(0, 3), urls.slice(3)];
    for (const [index, url] of urls.entries()) {
      const storageUrl = new URL([...bundleUris, ...assetUris][index]!);
      expect(`${new URL(url).origin}${new URL(url).pathname}`).toBe(
        `${publicBaseUrl}${storageUrl.pathname}`,
      );
    }
    expect(new Set(bundleUrls.map((url) => new URL(url).search)).size).toBe(1);
    expect(new Set(assetUrls.map((url) => new URL(url).search)).size).toBe(1);
    expect(readVerifiedPolicy(bundleUrls[0]!).Statement[0]!.Resource).toBe(
      `${publicBaseUrl}/production/bundles/0199-bundle/*`,
    );
    expect(readVerifiedPolicy(assetUrls[0]!).Statement[0]!.Resource).toBe(
      `${publicBaseUrl}/production/assets/*`,
    );
  });

  it("keeps a bundle's signature to that bundle", async () => {
    const publicBaseUrl = nextPublicBaseUrl();
    const getDownloadUrl = cloudFrontDownloadUrl({
      keyPairId: "K123",
      getPrivateKey: async () => privateKey,
      publicBaseUrl,
    });

    const first = await getDownloadUrl({
      storageUri: "s3://test-bucket/bundles/first/manifest.json",
    });
    const second = await getDownloadUrl({
      storageUri: "s3://test-bucket/bundles/second/manifest.json",
    });

    expect(getSignedUrl).toHaveBeenCalledTimes(2);
    expect(readVerifiedPolicy(first.url).Statement[0]!.Resource).toBe(
      `${publicBaseUrl}/bundles/first/*`,
    );
    expect(readVerifiedPolicy(second.url).Statement[0]!.Resource).toBe(
      `${publicBaseUrl}/bundles/second/*`,
    );
  });

  it("signs again once half of a signature's lifetime has passed", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 14) });
    try {
      const getDownloadUrl = cloudFrontDownloadUrl({
        keyPairId: "K123",
        getPrivateKey: async () => privateKey,
        publicBaseUrl: nextPublicBaseUrl(),
        expiresSeconds: 600,
      });

      const first = await getDownloadUrl({ storageUri: assetUri(1) });
      vi.advanceTimersByTime(299_000);
      const reused = await getDownloadUrl({ storageUri: assetUri(2) });
      vi.advanceTimersByTime(2_000);
      const renewed = await getDownloadUrl({ storageUri: assetUri(3) });

      expect(getSignedUrl).toHaveBeenCalledTimes(2);
      expect(new URL(reused.url).search).toBe(new URL(first.url).search);
      const renewedExpiry = readVerifiedPolicy(renewed.url).Statement[0]!
        .Condition.DateLessThan["AWS:EpochTime"];
      expect(renewedExpiry * 1000).toBe(Date.now() + 600_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps each configuration's signatures to its own lifetime", async () => {
    const publicBaseUrl = nextPublicBaseUrl();
    const configure = (expiresSeconds: number) =>
      cloudFrontDownloadUrl({
        keyPairId: "K123",
        getPrivateKey: async () => privateKey,
        publicBaseUrl,
        expiresSeconds,
      });

    const long = await configure(3600)({ storageUri: assetUri(1) });
    const short = await configure(60)({ storageUri: assetUri(1) });

    expect(getSignedUrl).toHaveBeenCalledTimes(2);
    const expiry = (url: string) =>
      readVerifiedPolicy(url).Statement[0]!.Condition.DateLessThan[
        "AWS:EpochTime"
      ] *
        1000 -
      Date.now();
    expect(expiry(long.url)).toBeGreaterThan(3_500_000);
    expect(expiry(short.url)).toBeLessThanOrEqual(60_000);
  });

  it("serves a cached signature while the secret store is unavailable", async () => {
    const getPrivateKey = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce(privateKey)
      .mockRejectedValue(new Error("secret store unavailable"));
    const getDownloadUrl = cloudFrontDownloadUrl({
      keyPairId: "K123",
      getPrivateKey,
      publicBaseUrl: nextPublicBaseUrl(),
    });

    const first = await getDownloadUrl({ storageUri: assetUri(1) });
    const cached = await getDownloadUrl({ storageUri: assetUri(2) });

    expect(new URL(cached.url).search).toBe(new URL(first.url).search);
    expect(getPrivateKey).toHaveBeenCalledOnce();
  });

  it("loads and caches the private key from SSM", async () => {
    const getParameter = vi
      .spyOn(SSM.prototype, "getParameter")
      .mockImplementation(
        async () =>
          ({
            Parameter: {
              Value: JSON.stringify({ privateKey }),
            },
          }) as any,
      );
    const getDownloadUrl = cloudFrontDownloadUrl({
      keyPairId: "K123",
      publicBaseUrl: nextPublicBaseUrl(),
      ssmRegion: "us-east-1",
      ssmParameterName: "/hot-updater/cloudfront/key-pair/download-url",
    });

    await getDownloadUrl({
      storageUri: "s3://test-bucket/releases/first.zip",
    });
    await getDownloadUrl({
      storageUri: "s3://test-bucket/releases/second.zip",
    });

    expect(getParameter).toHaveBeenCalledOnce();
  });
});
