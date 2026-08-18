import { createHotUpdater } from "@hot-updater/server";
import { getApps, initializeApp } from "firebase-admin/app";
import { onRequest } from "firebase-functions/v2/https";
import { Hono } from "hono";

import { firebaseDatabase } from "../../src/firebaseDatabase";
import { firebaseStorage } from "../../src/firebaseStorage";

declare global {
  var HotUpdater: {
    AUTHORITY_ID: string;
    REGION: string;
  };
}

export const HOT_UPDATER_BASE_PATH = "/";

const firebaseAdminApp = getApps()[0] ?? initializeApp();
const adminOptions = firebaseAdminApp.options;
const storageBucket = adminOptions.storageBucket;
const cdnUrl = process.env.HOT_UPDATER_CDN_URL;

if (!storageBucket) {
  throw new Error(
    "Firebase runtime requires storageBucket to read bundle manifests.",
  );
}

const hotUpdater = createHotUpdater({
  authorityId: HotUpdater.AUTHORITY_ID,
  database: firebaseDatabase({
    ...adminOptions,
    authorityId: HotUpdater.AUTHORITY_ID,
  }),
  features: {
    updateCheck: true,
    bundles: false,
    analytics: true,
  },
  storage: [
    firebaseStorage({
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

app.mount(HOT_UPDATER_BASE_PATH, hotUpdater.handler);

const handler = onRequest(
  {
    region: HotUpdater.REGION,
  },
  async (req, res) => {
    const host = req.hostname;
    const requestPath = req.originalUrl || req.url;
    const fullUrl = new URL(requestPath, `https://${host}`).toString();
    const request = new Request(fullUrl, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body:
        req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
    });
    const honoResponse = await app.fetch(request);
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
