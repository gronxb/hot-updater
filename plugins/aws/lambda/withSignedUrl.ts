import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import { NIL_UUID } from "@hot-updater/core";

/**
 * Creates a CloudFront signed URL based on the provided update information.
 *
 * @param {Object} options - Function options
 * @param {T|null} options.data - Update information (null if none)
 * @param {string} options.reqUrl - Request URL (base URL for URL generation)
 * @param {string} options.keyPairId - CloudFront key pair ID
 * @param {string} options.privateKey - CloudFront private key
 * @returns {Promise<T|null>} - Update response object with fileUrl or null
 */
export const withSignedUrl = async <T extends { id: string }>({
  data,
  reqUrl,
  keyPairId,
  privateKey,
}: {
  data: T | null;
  reqUrl: string;
  keyPairId: string;
  privateKey: string;
}): Promise<(T & { fileUrl: string | null }) | null> => {
  if (!data) {
    return null;
  }

  if (data.id === NIL_UUID) {
    return { ...data, fileUrl: null };
  }

  const key = `${data.id}/bundle.zip`;

  const url = new URL(reqUrl);
  url.pathname = `/${key}`;

  // Create CloudFront signed URL
  const signedUrl = getSignedUrl({
    url: url.toString(),
    keyPairId: keyPairId,
    privateKey: privateKey,
    dateLessThan: new Date(Date.now() + 60 * 1000).toISOString(), // Valid for 60 seconds
  });

  return { ...data, fileUrl: signedUrl };
};
