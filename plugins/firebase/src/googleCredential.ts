import type { Credential } from "firebase-admin/app";

/**
 * Resolves application default credentials the way Firestore will, from
 * GOOGLE_APPLICATION_CREDENTIALS's file or the environment, without an
 * OAuth exchange Firestore itself may not make: firebase-admin's
 * `applicationDefault()` holds a `GoogleAuth` as `googleAuth`. A service
 * account's or refresh token's credential was read from its file already.
 */
export const resolveApplicationDefault = async (
  credential: Credential,
): Promise<void> => {
  const googleAuth: unknown = Reflect.get(credential, "googleAuth");
  const getClient =
    typeof googleAuth === "object" && googleAuth !== null
      ? Reflect.get(googleAuth, "getClient")
      : undefined;
  if (typeof getClient === "function") await getClient.call(googleAuth);
};
