import {
  createHotUpdater,
  rewriteLegacyExactRequestToCanonical,
  wildcardPattern,
} from "@hot-updater/server";
import * as admin from "firebase-admin";
import { Hono } from "hono";
import { firebaseFunctionsDatabase, firebaseFunctionsStorage } from "../../src";
import { createFirebaseApp } from "./createFirebaseApp";

declare global {
  var HotUpdater: {
    REGION: string;
  };
}

if (!admin.apps.length) {
  admin.initializeApp();
}

const HOT_UPDATER_METHODS = ["GET", "POST", "PATCH", "DELETE"];
const HOT_UPDATER_BASE_PATH = "/api/check-update";
const adminOptions = admin.app().options;
const storageBucket = adminOptions.storageBucket;
const cdnUrl = process.env.HOT_UPDATER_CDN_URL;

if (!storageBucket && !cdnUrl) {
  throw new Error(
    "Firebase runtime requires storageBucket or HOT_UPDATER_CDN_URL to resolve bundle URLs.",
  );
}

const hotUpdater = createHotUpdater({
  database: firebaseFunctionsDatabase(adminOptions),
  storages: [
    firebaseFunctionsStorage({
      ...adminOptions,
      storageBucket,
      cdnUrl,
    }),
  ],
  basePath: HOT_UPDATER_BASE_PATH,
});

const app = new Hono();

app.get("/ping", (c) => {
  return c.text("pong");
});

app.get(HOT_UPDATER_BASE_PATH, async (c) => {
  const rewrittenRequest = rewriteLegacyExactRequestToCanonical({
    basePath: hotUpdater.basePath,
    request: c.req.raw,
  });

  if (rewrittenRequest instanceof Response) {
    return rewrittenRequest;
  }

  return hotUpdater.handler(rewrittenRequest);
});

app.on(
  HOT_UPDATER_METHODS,
  wildcardPattern(HOT_UPDATER_BASE_PATH),
  async (c) => {
    return hotUpdater.handler(c.req.raw);
  },
);

export const handler = createFirebaseApp({
  region: HotUpdater.REGION,
})(app);
