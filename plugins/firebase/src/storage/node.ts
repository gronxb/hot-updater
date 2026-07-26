import { createFirebaseAdminClient } from "./firebaseAdmin";
import {
  createFirebaseStorage,
  type FirebaseStorageConfig,
} from "./firebaseStorage";

export type { FirebaseStorageConfig };

export const firebaseStorage = (config: FirebaseStorageConfig) =>
  createFirebaseStorage(config, "node", createFirebaseAdminClient);
