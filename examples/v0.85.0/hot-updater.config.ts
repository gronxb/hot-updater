import { bare } from "@hot-updater/bare";
import { firebaseDatabase, firebaseStorage } from "@hot-updater/firebase";
import { config } from "dotenv";
import { applicationDefault } from "firebase-admin/app";
import { defineConfig } from "hot-updater";

config({
  path: process.env.HOT_UPDATER_E2E_ENV_TARGET_PATH ?? ".env.hotupdater",
});

// https://firebase.google.com/docs/admin/setup?hl=en#initialize_the_sdk_in_non-google_environments
// Check your .env.hotupdater file and add the credentials
// Set the GOOGLE_APPLICATION_CREDENTIALS environment variable to your credentials file path
// Example: GOOGLE_APPLICATION_CREDENTIALS=./firebase-adminsdk-credentials.json
const credential = applicationDefault();

export default defineConfig({
  nativeBuild: {
    android: {
      debugApk: {
        packageName: "com.hotupdaterexample",
        aab: false,
        variant: "Debug",
      },
      releaseApk: {
        packageName: "com.hotupdaterexample",
        aab: false,
      },
    },
    ios: {
      debug: {
        bundleIdentifier: "com.hotupdaterexample",
        scheme: "HotUpdaterExample",
        configuration: "Debug",
        installPods: false,
        simulator: true,
      },
      release: {
        bundleIdentifier: "com.hotupdaterexample",
        scheme: "HotUpdaterExample",
        configuration: "Release",
        installPods: true,
      },
    },
  },

  build: bare({ enableHermes: true, resetCache: false }),
  storage: firebaseStorage({
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
    storageBucket: process.env.HOT_UPDATER_FIREBASE_STORAGE_BUCKET!,
    credential,
  }),
  database: firebaseDatabase({
    authorityId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
    credential,
  }),
  fingerprint: {
    debug: true,
  },
  /* E2E_AUTO_PATCH_CONFIG_START */
  patch: {
    enabled: true,
    maxBaseBundles: 2,
  },
  /* E2E_AUTO_PATCH_CONFIG_END */
  updateStrategy: "appVersion",
  signing: {
    enabled: true,
    privateKeyPath: "./keys/private-key.pem",
  },

  authorityId: "hot-updater-25989",
});
