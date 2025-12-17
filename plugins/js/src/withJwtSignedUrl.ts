import { NIL_UUID } from "@hot-updater/core";
import { SignJWT } from "jose";

/**
 * Creates a JWT-signed download URL based on the provided update information.
 *
 * @param {Object} options - Function options
 * @param {T|null} options.data - Update information (null if none)
 * @param {string} options.reqUrl - Request URL (base URL for token generation)
 * @param {string} options.jwtSecret - Secret key for JWT signing
 * @returns {Promise<T|null>} - Update response object with fileUrl or null
 */
export const withJwtSignedUrl = async <
  T extends { id: string; storageUri: string | null },
>({
  data,
  reqUrl,
  jwtSecret,
}: {
  data: T | null;
  reqUrl: string;
  jwtSecret: string;
}): Promise<
  | (Omit<T, "storageUri"> & {
      fileUrl: string | null;
      headFileUrl: string | null;
    })
  | null
> => {
  if (!data) {
    return null;
  }

  const { storageUri, ...rest } = data;
  if (data.id === NIL_UUID || !storageUri) {
    return { ...rest, fileUrl: null, headFileUrl: null };
  }
  const storageUrl = new URL(storageUri);
  const key = `${storageUrl.host}${storageUrl.pathname}`;
  const token = await signToken(key, jwtSecret);

  const url = new URL(reqUrl);
  url.pathname = key;
  url.searchParams.set("token", token);

  // JWT-signed URLs are method-agnostic, so the same URL works for both GET and HEAD
  const signedUrl = url.toString();
  return { ...rest, fileUrl: signedUrl, headFileUrl: signedUrl };
};

export const signToken = async (key: string, jwtSecret: string) => {
  const secretKey = new TextEncoder().encode(jwtSecret);
  const token = await new SignJWT({ key })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("60s")
    .sign(secretKey);

  return token;
};
