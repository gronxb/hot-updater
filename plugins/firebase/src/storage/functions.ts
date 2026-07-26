import { createFirebaseAdminClient } from "./firebaseAdmin";
import {
  createFirebaseStorage,
  type FirebaseStorageConfig,
} from "./firebaseStorage";

export { createFunctionsStorageContext } from "./functionsContext";
export type { FirebaseStorageConfig };

export const firebaseStorage = (config: FirebaseStorageConfig) =>
  createFirebaseStorage(config, "functions", createFirebaseAdminClient);
