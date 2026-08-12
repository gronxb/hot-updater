import { parseStorageUri } from "@hot-updater/plugin-core";
import {
  getApp,
  getApps,
  initializeApp,
  type AppOptions,
} from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

export interface FirebaseStorageDeliveryConfig extends AppOptions {
  storageBucket: string;
  cdnUrl?: string;
  expiresSeconds?: number;
}

export const firebaseStorageDelivery = (
  config: FirebaseStorageDeliveryConfig,
) => {
  const app = getApps().length ? getApp() : initializeApp(config);
  const bucket = getStorage(app).bucket(config.storageBucket);

  return {
    async resolveUrl(storageUri: string): Promise<string | null> {
      const parsed = parseStorageUri(storageUri, "gs");
      if (parsed.bucket !== config.storageBucket) {
        throw new Error(
          `Bucket name mismatch: expected "${config.storageBucket}", but found "${parsed.bucket}".`,
        );
      }

      if (config.cdnUrl) {
        return `${config.cdnUrl.replace(/\/+$/, "")}/${parsed.key}`;
      }

      const [signedUrl] = await bucket.file(parsed.key).getSignedUrl({
        action: "read",
        expires: Date.now() + (config.expiresSeconds ?? 60 * 60) * 1000,
      });
      if (!signedUrl) throw new Error("Failed to generate download URL");
      return signedUrl;
    },
  };
};
