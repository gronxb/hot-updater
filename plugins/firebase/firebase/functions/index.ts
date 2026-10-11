import { createHotUpdater } from "@hot-updater/server";
import { apiKeys, insights, remoteConfig } from "@hot-updater/server/plugins";
import { getApps, initializeApp } from "firebase-admin/app";
import { onRequest } from "firebase-functions/v2/https";
import { Hono } from "hono";

import { firebaseDatabase } from "../../src/firebaseDatabase";
import { firebaseStorage } from "../../src/firebaseStorage";

declare global {
  var HotUpdater: {
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
  }),
  plugins: [insights(), apiKeys(), remoteConfig()],
  storage: firebaseStorage({
    ...adminOptions,
    storageBucket,
    cdnUrl,
  }),
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
        req.method !== "GET" && req.method !== "HEAD"
          ? new Uint8Array(req.rawBody)
          : undefined,
    });
    const honoResponse = await app.fetch(request);
    res.status(honoResponse.status);
    for (const [key, value] of honoResponse.headers.entries()) {
      if (key !== "set-cookie") res.setHeader(key, value);
    }
    // Each cookie its own header, which a joined value would merge.
    const cookies = honoResponse.headers.getSetCookie();
    if (cookies.length > 0) res.setHeader("set-cookie", cookies);
    // The bytes as they are: a route may answer with binary data, such as
    // a storage object the server serves itself.
    res.send(Buffer.from(await honoResponse.arrayBuffer()));
  },
);

// Firebase encodes hyphenated function names as nested entry points.
export const hot = {
  updater: {
    v1: handler,
  },
};
