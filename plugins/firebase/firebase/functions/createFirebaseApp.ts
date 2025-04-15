import type { HttpsFunction } from "firebase-functions/v2/https";
import { onRequest } from "firebase-functions/v2/https";
import type { Hono } from "hono";
import type { BlankEnv, BlankSchema } from "hono/types";
interface RegionOptions {
  region: string;
}

export function createFirebaseApp({
  region,
}: RegionOptions): (app: Hono<BlankEnv, BlankSchema, "/">) => HttpsFunction {
  return (app: Hono<BlankEnv, BlankSchema, "/">): HttpsFunction => {
    return onRequest(
      {
        region,
      },
      async (req, res) => {
        const host = req.hostname;
        const path = req.originalUrl || req.url;
        const fullUrl = new URL(path, `https://${host}`).toString();
        const request = new Request(fullUrl, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body:
            req.method !== "GET" && req.method !== "HEAD"
              ? req.body
              : undefined,
        });
        const honoResponse = await app.fetch(request);
        res.status(honoResponse.status);
        honoResponse.headers.forEach((value: string, key: string) => {
          res.setHeader(key, value);
        });
        const body: string = await honoResponse.text();
        res.send(body);
      },
    );
  };
}
