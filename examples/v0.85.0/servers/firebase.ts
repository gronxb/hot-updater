import {
  firebaseDatabase,
  firebaseStorage,
  plugins,
} from "@hot-updater/firebase";
import { createHotUpdater } from "@hot-updater/server";
import { applicationDefault } from "firebase-admin/app";

import { sample } from "./samplePlugin";

// https://firebase.google.com/docs/admin/setup?hl=en#initialize_the_sdk_in_non-google_environments
// Reuse working application-default credentials (ADC).
// Only when a credential file is needed, set its private local path in .env.hotupdater:
// GOOGLE_APPLICATION_CREDENTIALS=./firebase-adminsdk-credentials.json
const credential = applicationDefault();

/**
 * The Hot Updater server: its database, storage, and plugins.
 * hot-updater.config.ts points the CLI and the console here.
 */
export const hotUpdater = createHotUpdater({
  database: firebaseDatabase({
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
    credential,
  }),
  storage: [
    firebaseStorage({
      projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
      storageBucket: process.env.HOT_UPDATER_FIREBASE_STORAGE_BUCKET!,
      credential,
    }),
  ],
  plugins: [...plugins, sample()],
});
