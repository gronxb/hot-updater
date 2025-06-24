// New Firebase Function using @hot-updater/server
import * as admin from "firebase-admin";
import { onRequest } from "firebase-functions/v2/https";
import { HotUpdater, firestoreDatabase, firebaseStorage } from "@hot-updater/server";

declare global {
  var HotUpdater: {
    REGION: string;
  };
}

if (!admin.apps.length) {
  admin.initializeApp();
}

const hotUpdater = new HotUpdater({
  database: firestoreDatabase({
    firestore: admin.firestore(),
    storage: admin.storage(),
    storageBucket: admin.app().options.storageBucket
  }),
  storage: firebaseStorage({
    firestore: admin.firestore(),
    storage: admin.storage(),
    storageBucket: admin.app().options.storageBucket
  })
});

export const hot = {
  updater: onRequest(
    { region: HotUpdater.REGION },
    async (req, res) => {
      // Convert Express request to Web API Request
      const url = new URL(req.url!, `https://${req.headers.host}`);
      
      const headers = new Headers();
      Object.entries(req.headers).forEach(([key, value]) => {
        if (value) {
          headers.set(key, Array.isArray(value) ? value[0] : value);
        }
      });

      const body = req.method !== 'GET' && req.method !== 'HEAD' 
        ? JSON.stringify(req.body) 
        : undefined;

      const request = new Request(url.toString(), {
        method: req.method,
        headers,
        body,
      });

      const response = await hotUpdater.handler(request);
      
      // Convert Web API Response to Express response
      res.status(response.status);
      
      response.headers.forEach((value, key) => {
        res.set(key, value);
      });

      const responseBody = await response.text();
      res.send(responseBody);
    }
  )
};