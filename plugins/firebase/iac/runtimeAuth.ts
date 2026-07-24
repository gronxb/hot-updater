import { provisionApiKey } from "@hot-updater/api-key/provisioning";

export type FirebaseRuntimeAuth = {
  readonly API_KEY_SHA256: string;
};

export const prepareFirebaseRuntimeAuth = async (
  envFilePath: string,
): Promise<FirebaseRuntimeAuth> => {
  const { sha256 } = await provisionApiKey({ envFilePath });
  return Object.freeze({ API_KEY_SHA256: sha256 });
};
