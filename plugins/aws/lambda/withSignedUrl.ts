import { GetObjectCommand, S3 } from "@aws-sdk/client-s3";
import { NIL_UUID } from "@hot-updater/core";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3Clients = new Map<string, S3>();

const getS3Client = (region: string) => {
  const existingClient = s3Clients.get(region);
  if (existingClient) {
    return existingClient;
  }

  const client = new S3({ region });
  s3Clients.set(region, client);
  return client;
};

/**
 * Creates a signed download URL based on the provided update information.
 *
 * @param {Object} options - Function options
 * @param {T|null} options.data - Update information (null if none)
 * @param {string} options.region - S3 bucket region
 * @returns {Promise<T|null>} - Update response object with fileUrl or null
 */
export const withSignedUrl = async <
  T extends { id: string; storageUri: string | null },
>({
  data,
  region,
  expiresSeconds = 60,
}: {
  data: T | null;
  region: string;
  expiresSeconds?: number;
}): Promise<(Omit<T, "storageUri"> & { fileUrl: string | null }) | null> => {
  if (!data) {
    return null;
  }

  const { storageUri: _, ...rest } = data;
  if (data.id === NIL_UUID || !data.storageUri) {
    return { ...rest, fileUrl: null };
  }

  const storageUrl = new URL(data.storageUri);
  const bucket = storageUrl.host;
  const key = storageUrl.pathname.slice(1);

  const signedUrl = await getSignedUrl(
    getS3Client(region),
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
    {
      expiresIn: expiresSeconds,
    },
  );

  return { ...rest, fileUrl: signedUrl };
};
