import type { Credential } from "firebase-admin/app";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/**
 * Resolves application default credentials as Firestore will, from
 * GOOGLE_APPLICATION_CREDENTIALS's file or the environment, for the app's
 * `projectId`, so it neither exchanges a token nor discovers a project
 * Firestore itself wouldn't. Only `applicationDefault()`'s credential: a
 * service account's or refresh token's was read from its file already.
 */
export const resolveApplicationDefault = async (
  credential: Credential,
  projectId: string | undefined,
): Promise<void> => {
  // By its class's name, which creating one to compare with would load, as
  // firebase-admin before 13 does. Those return a credential of another
  // class, which this leaves alone.
  if (credential.constructor.name !== "ApplicationDefaultCredential") return;
  const { GoogleAuth } = await import("google-auth-library");
  await new GoogleAuth({
    scopes: [CLOUD_PLATFORM_SCOPE],
    ...(projectId === undefined ? {} : { projectId }),
  }).getClient();
};
