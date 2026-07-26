import {
  analytics,
  ANALYTICS_EVENT_BODY_MAX_BYTES,
} from "@hot-updater/analytics";
import { managedBetterAuthPlugin } from "@hot-updater/better-auth/managed";
import { createHotUpdater } from "@hot-updater/server";
import admin from "firebase-admin";
import { onRequest } from "firebase-functions/v2/https";
import { Hono } from "hono";

import { firebaseDatabase, firebaseStorage } from "../../src/functions";
import {
  createFirebaseWebRequest,
  FIREBASE_FUNCTION_CONCURRENCY,
  FIREBASE_FUNCTION_MAX_INSTANCES,
  sendFirebasePayloadTooLarge,
} from "./requestAdapter";

declare global {
  var HotUpdater: {
    API_KEY_SHA256: string;
    REGION: string;
  };
}

export const HOT_UPDATER_BASE_PATH = "/api/check-update";

if (!admin.apps.length) {
  admin.initializeApp();
}

const adminOptions = admin.app().options;
const storageBucket = adminOptions.storageBucket;
const cdnUrl = process.env.HOT_UPDATER_CDN_URL;

if (!storageBucket) {
  throw new Error(
    "Firebase runtime requires storageBucket to read bundle manifests.",
  );
}

const hotUpdater = createHotUpdater({
  database: firebaseDatabase(),
  storages: [
    firebaseStorage({
      storageBucket,
      cdnUrl,
    })(),
  ],
  basePath: "/",
  routes: {
    bundles: false,
    updateCheck: true,
  },
  plugins: [
    managedBetterAuthPlugin({
      apiKeySha256: HotUpdater.API_KEY_SHA256,
    }),
    analytics(),
  ],
});

const app = new Hono();

app.get("/ping", (c) => {
  return c.text("pong");
});

app.mount(HOT_UPDATER_BASE_PATH, hotUpdater.handler);

const handler = onRequest(
  {
    concurrency: FIREBASE_FUNCTION_CONCURRENCY,
    maxInstances: FIREBASE_FUNCTION_MAX_INSTANCES,
    region: HotUpdater.REGION,
  },
  async (req, res) => {
    const requestResult = createFirebaseWebRequest(
      req,
      ANALYTICS_EVENT_BODY_MAX_BYTES,
    );
    if (requestResult.kind === "payload-too-large") {
      sendFirebasePayloadTooLarge(res);
      return;
    }

    const honoResponse = await app.fetch(requestResult.request);
    res.status(honoResponse.status);
    for (const [key, value] of honoResponse.headers.entries()) {
      res.setHeader(key, value);
    }
    res.send(await honoResponse.text());
  },
);

// Firebase encodes hyphenated function names as nested entry points,
// e.g. "hot-updater" -> "hot.updater".
export const hot = {
  updater: handler,
};
