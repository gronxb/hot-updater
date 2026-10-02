import { generateKeyPairSync } from "node:crypto";

import { setupStorageAdapterTestSuite } from "@hot-updater/test-utils";
import { cert } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

import { firebaseStorage } from "./firebaseStorage";

const projectId = process.env.GCLOUD_PROJECT;
if (!projectId || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
  throw new Error(
    "firebaseStorage on the Storage emulator requires GCLOUD_PROJECT and FIREBASE_STORAGE_EMULATOR_HOST, which the firebase integration group's emulators set.",
  );
}
const storageBucket = `${projectId}.appspot.com`;

/**
 * A service account key made for this run. The emulator takes no
 * credentials, and `getSignedUrl` signs its URLs locally with the key.
 */
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const credential = cert({
  clientEmail: `conformance@${projectId}.iam.gserviceaccount.com`,
  privateKey,
  projectId,
});

/** firebaseStorage on the Storage emulator, each case below a base path of its own. */
setupStorageAdapterTestSuite({
  name: "firebaseStorage (Storage emulator)",
  fetchDownloadUrls: true,
  createStorage: async () => {
    const basePath = `conformance/${crypto.randomUUID()}`;
    return {
      storage: firebaseStorage({
        basePath,
        credential,
        projectId,
        storageBucket,
      }),
      basePath,
      cleanup: async () => {
        await getStorage()
          .bucket(storageBucket)
          .deleteFiles({ prefix: `${basePath}/` });
      },
    };
  },
  operations: ["put", "get", "getDownloadUrl", "exists", "delete"],
});
