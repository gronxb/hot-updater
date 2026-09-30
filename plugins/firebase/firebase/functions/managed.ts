import type { HotUpdaterHandlers } from "@hot-updater/server";
import { getApps, initializeApp } from "firebase-admin/app";
import { onRequest } from "firebase-functions/v2/https";
import { Hono } from "hono";

import { firebaseDatabase as projectDatabase } from "../../src/firebaseDatabase";
import { firebaseStorage as projectStorage } from "../../src/firebaseStorage";

export { migrateFirebaseDatabase } from "../../src/firebaseDatabase";
export { plugins } from "../../src/plugins";

declare global {
  var HotUpdater: {
    REGION: string;
  };
}

/** The function's Firebase app: its project, service account, and default bucket. */
const functionAppOptions = () => (getApps()[0] ?? initializeApp()).options;

/*
 * The managed Cloud Function runs the project's server definition with this
 * module in place of `@hot-updater/firebase`: the definition's database and
 * storage are the function's own project and default bucket, reached with
 * its service account, and the credentials it passes, which are the CLI's,
 * go unused.
 */

/** The server definition's database in the managed function: its project's Firestore. */
export const firebaseDatabase = (_config?: unknown) =>
  projectDatabase({ ...functionAppOptions() });

/** The server definition's storage in the managed function: its project's default bucket. */
export const firebaseStorage = (_config?: unknown) => {
  const options = functionAppOptions();
  if (!options.storageBucket) {
    throw new Error(
      "Firebase runtime requires storageBucket to read bundle manifests.",
    );
  }
  return projectStorage({
    ...options,
    storageBucket: options.storageBucket,
    cdnUrl: process.env.HOT_UPDATER_CDN_URL,
  });
};

export const HOT_UPDATER_BASE_PATH = "/";

/**
 * The managed Cloud Function, `hot-updater-v1`: the server definition's
 * client routes. Firebase encodes hyphenated function names as nested entry
 * points, so a module exports it as `hot`.
 */
export const serveManagedFunction = (hotUpdater: {
  readonly handlers: Pick<HotUpdaterHandlers, "client">;
}) => {
  const app = new Hono();

  app.get("/ping", (c) => {
    return c.text("pong");
  });

  app.mount(HOT_UPDATER_BASE_PATH, (request: Request) =>
    hotUpdater.handlers.client(request),
  );

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
      // The bytes as they are: a plugin may answer with binary data.
      res.send(Buffer.from(await honoResponse.arrayBuffer()));
    },
  );

  return {
    updater: {
      v1: handler,
    },
  };
};
