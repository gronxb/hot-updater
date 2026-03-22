import { GetObjectCommand, S3 } from "@aws-sdk/client-s3";
import {
  type AppVersionGetBundlesArgs,
  type Bundle,
  type FingerprintGetBundlesArgs,
  type GetBundlesArgs,
  NIL_UUID,
  type UpdateInfo,
} from "@hot-updater/core";
import {
  filterCompatibleAppVersions,
  getUpdateInfo as getUpdateInfoJS,
} from "@hot-updater/js";

const s3Clients = new Map<string, S3>();

type ManifestJsonReader = <T>(key: string) => Promise<T | null>;

const getS3Client = (region: string) => {
  const existingClient = s3Clients.get(region);
  if (existingClient) {
    return existingClient;
  }

  const client = new S3({ region });
  s3Clients.set(region, client);
  return client;
};

const getS3Json = async <T>({
  bucketName,
  key,
  region,
}: {
  bucketName: string;
  key: string;
  region: string;
}): Promise<T | null> => {
  try {
    const response = await getS3Client(region).send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: key,
      }),
    );

    const body = await response.Body?.transformToString();
    if (!body) {
      return null;
    }

    return JSON.parse(body) as T;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "NoSuchKey" || error.name === "NotFound")
    ) {
      return null;
    }

    console.error("Failed to read Hot Updater manifest from S3:", {
      key,
      error,
    });
    return null;
  }
};

export const getUpdateInfo = async (
  {
    bucketName,
    region,
    readManifestJson,
  }: {
    bucketName: string;
    region: string;
    readManifestJson?: ManifestJsonReader;
  },
  args: GetBundlesArgs,
): Promise<UpdateInfo | null> => {
  const manifestReader =
    readManifestJson ??
    (<T>(key: string) =>
      getS3Json<T>({
        bucketName,
        key,
        region,
      }));

  switch (args._updateStrategy) {
    case "appVersion":
      return appVersionStrategy({ readManifestJson: manifestReader }, args);
    case "fingerprint":
      return fingerprintStrategy({ readManifestJson: manifestReader }, args);
    default:
      return null;
  }
};

const appVersionStrategy = async (
  {
    readManifestJson,
  }: {
    readManifestJson: ManifestJsonReader;
  },
  {
    platform,
    appVersion,
    bundleId,
    minBundleId = NIL_UUID,
    channel = "production",
    cohort,
  }: AppVersionGetBundlesArgs,
): Promise<UpdateInfo | null> => {
  const targetAppVersions = await readManifestJson<string[]>(
    `${channel}/${platform}/target-app-versions.json`,
  );

  const matchingVersions = filterCompatibleAppVersions(
    targetAppVersions ?? [],
    appVersion,
  );

  const results = await Promise.allSettled(
    matchingVersions.map((targetAppVersion) =>
      readManifestJson<Bundle[]>(
        `${channel}/${platform}/${targetAppVersion}/update.json`,
      ),
    ),
  );

  const bundles = results
    .filter(
      (r): r is PromiseFulfilledResult<Bundle[]> => r.status === "fulfilled",
    )
    .flatMap((r) => r.value ?? []);

  return getUpdateInfoJS(bundles, {
    platform,
    bundleId,
    appVersion,
    minBundleId,
    channel,
    cohort,
    _updateStrategy: "appVersion",
  });
};

const fingerprintStrategy = async (
  {
    readManifestJson,
  }: {
    readManifestJson: ManifestJsonReader;
  },
  {
    platform,
    fingerprintHash,
    bundleId,
    minBundleId = NIL_UUID,
    channel = "production",
    cohort,
  }: FingerprintGetBundlesArgs,
): Promise<UpdateInfo | null> => {
  const result = await readManifestJson<Bundle[]>(
    `${channel}/${platform}/${fingerprintHash}/update.json`,
  );

  return getUpdateInfoJS(result ?? [], {
    platform,
    bundleId,
    fingerprintHash,
    minBundleId,
    channel,
    cohort,
    _updateStrategy: "fingerprint",
  });
};
