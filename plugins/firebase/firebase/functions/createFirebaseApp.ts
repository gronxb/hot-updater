import type * as functions from "firebase-functions/v1";
import type {
  Request as FunctionsRequest,
  Response as FunctionsResponse,
} from "firebase-functions/v1";
import type { Hono } from "hono";
import type { BlankEnv, BlankSchema } from "hono/types";

interface RegionOptions {
  region: string;
}

export function createFirebaseApp(
  firebaseInstance: typeof functions,
  { region }: RegionOptions,
): (app: Hono<BlankEnv, BlankSchema, "/">) => functions.HttpsFunction {
  return (app: Hono<BlankEnv, BlankSchema, "/">): functions.HttpsFunction => {
    return firebaseInstance
      .region(region)
      .https.onRequest(
        async (req: FunctionsRequest, res: FunctionsResponse) => {
          const host: string = req.hostname;
          const path: string = req.originalUrl || req.url;
          const fullUrl: string = new URL(path, `https://${host}`).toString();
          const request: Request = new Request(fullUrl, {
            method: req.method,
            headers: req.headers as Record<string, string>,
            body:
              req.method !== "GET" && req.method !== "HEAD"
                ? req.body
                : undefined,
          });
          const honoResponse: Response = await app.fetch(request);
          res.status(honoResponse.status);
          honoResponse.headers.forEach((value: string, key: string) => {
            res.set(key, value);
          });
          const body: string = await honoResponse.text();
          res.send(body);
        },
      );
  };
}
