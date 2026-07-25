import { provisionManagedBetterAuthApiKey } from "@hot-updater/better-auth/managed/provisioning";

export type FirebaseRuntimeAuth = {
  readonly API_KEY_SHA256: string;
};

export const prepareFirebaseRuntimeAuth = async (
  envFilePath: string,
): Promise<FirebaseRuntimeAuth> => {
  const { sha256 } = await provisionManagedBetterAuthApiKey({ envFilePath });
  return Object.freeze({ API_KEY_SHA256: sha256 });
};
