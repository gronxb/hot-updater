import {
  type AppUpdateInfo,
  NIL_UUID,
  type UpdateInfo,
} from "@hot-updater/core";
import { SignJWT } from "jose";

/**
 * Creates a JWT-based download URL based on the provided update information.
 *
 * @param {Object|null} updateInfo - Update information (null if none)
 * @param {string} reqUrl - Request URL (base URL for token generation)
 * @param {string} jwtSecret - Secret key for JWT signing
 * @returns {Promise<Object|null>} - Update response object with fileUrl or null
 */
export const withJwtSignedUrl = async (
  updateInfo: UpdateInfo | null,
  reqUrl: string,
  jwtSecret: string,
): Promise<AppUpdateInfo | null> => {
  if (!updateInfo) {
    return null;
  }

  if (updateInfo.id === NIL_UUID) {
    return { ...updateInfo, fileUrl: null };
  }

  const key = `${updateInfo.id}/bundle.zip`;
  const secretKey = new TextEncoder().encode(jwtSecret);
  const token = await new SignJWT({ key })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("60s")
    .sign(secretKey);

  const url = new URL(reqUrl);
  url.pathname = `/${key}`;
  url.searchParams.set("token", token);

  return { ...updateInfo, fileUrl: url.toString() };
};
