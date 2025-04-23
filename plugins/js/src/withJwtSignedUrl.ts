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
export const withJwtSignedUrl = async <T extends { id: string }>({
  pathPrefix = "",
  data,
  reqUrl,
  jwtSecret,
}: {
  pathPrefix?: string;
  data: T | null;
  reqUrl: string;
  jwtSecret: string;
}): Promise<(T & { fileUrl: string | null }) | null> => {
  if (!data) {
    return null;
  }

  if (data.id === NIL_UUID) {
    return { ...data, fileUrl: null };
  }

  const key = `${data.id}/bundle.zip`;
  const token = await signToken(key, jwtSecret);

  const url = new URL(reqUrl);
  url.pathname = `${pathPrefix}/${key}`;
  url.searchParams.set("token", token);

  return { ...data, fileUrl: url.toString() };
};

export const signToken = async (key: string, jwtSecret: string) => {
  const secretKey = new TextEncoder().encode(jwtSecret);
  const token = await new SignJWT({ key })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("60s")
    .sign(secretKey);

  return token;
};
