import { createHotUpdater } from "@hot-updater/server";
import * as admin from "firebase-admin";
import {
  createFirebaseFunctionsHandler,
  HOT_UPDATER_BASE_PATH,
} from "./runtime";
import { firebaseDatabase } from "../../src/firebaseDatabase";
import { firebaseFunctionsStorage } from "../../src/firebaseFunctionsStorage";

declare global {
  var HotUpdater: {
    REGION: string;
  };
}

if (!admin.apps.length) {
  admin.initializeApp();
}

const adminOptions = admin.app().options;
const storageBucket = adminOptions.storageBucket;
const cdnUrl = process.env.HOT_UPDATER_CDN_URL;

if (!storageBucket && !cdnUrl) {
  throw new Error(
    "Firebase runtime requires storageBucket or HOT_UPDATER_CDN_URL to resolve bundle URLs.",
  );
}

const hotUpdater = createHotUpdater({
  database: firebaseDatabase(adminOptions),
  storages: [
    firebaseFunctionsStorage({
      ...adminOptions,
      storageBucket,
      cdnUrl,
    }),
  ],
  basePath: HOT_UPDATER_BASE_PATH,
  routes: {
    updateCheck: true,
    bundles: false,
  },
});

export const handler = createFirebaseFunctionsHandler({
  region: HotUpdater.REGION,
  getHotUpdater: () => hotUpdater,
});
