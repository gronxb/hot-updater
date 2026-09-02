import { createHotUpdater } from "@hot-updater/server";
import { getApps, initializeApp } from "firebase-admin/app";
import { onRequest } from "firebase-functions/v2/https";
import { Hono } from "hono";

import { firebaseDatabase } from "../../src/firebaseDatabase";
import { firebaseStorage } from "../../src/firebaseStorage";

declare global {
  var HotUpdater: {
    INSIGHTS_DATABASE_NAMESPACE: string;
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
  database: firebaseDatabase({
    ...adminOptions,
    insightsDatabaseNamespace: HotUpdater.INSIGHTS_DATABASE_NAMESPACE,
  }),
  clientAccess: { type: "api-key" },
  storage: [
    firebaseStorage({
      ...adminOptions,
      storageBucket,
      cdnUrl,
    }),
  ],
});

const app = new Hono();

app.get("/ping", (c) => {
  return c.text("pong");
});

app.mount(HOT_UPDATER_BASE_PATH, hotUpdater.handlers.client);

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

// Firebase encodes hyphenated function names as nested entry points.
export const hot = {
  updater: {
    v1: handler,
  },
};
