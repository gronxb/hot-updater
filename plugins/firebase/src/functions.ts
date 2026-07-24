import admin from "firebase-admin";

import { firebaseDatabase as createFirebaseDatabase } from "./firebaseDatabase";
import {
  firebaseFunctionsStorage as createFirebaseStorage,
  type FirebaseFunctionsStorageConfig,
} from "./firebaseFunctionsStorage";

export interface FirebaseStorageConfig {
  readonly cdnUrl?: string;
  readonly storageBucket?: string;
}

const getAppOptions = (): admin.AppOptions => {
  const app =
    admin.apps.find((candidate) => candidate !== null) ?? admin.initializeApp();
  return app.options;
};

export const firebaseDatabase = () => createFirebaseDatabase(getAppOptions());

export const firebaseStorage = (config: FirebaseStorageConfig = {}) =>
  createFirebaseStorage({
    ...getAppOptions(),
    ...config,
  } satisfies FirebaseFunctionsStorageConfig);
