import type * as functions from "firebase-functions/v1";
import type {
  Request as FunctionsRequest,
  Response as FunctionsResponse,
} from "firebase-functions/v1";
import type { Hono } from "hono";
import type { BlankEnv, BlankSchema } from "hono/types";

interface CreateAppOptions {
  region: string;
  honoApp: Hono<BlankEnv, BlankSchema, "/">;
}

export function createApp(
  functionsInstance: typeof functions,
  options: CreateAppOptions,
): functions.HttpsFunction {
  const { region, honoApp } = options;

  return functionsInstance
    .region(region)
    .https.onRequest(async (req: FunctionsRequest, res: FunctionsResponse) => {
      const host = req.hostname;
      const path = req.originalUrl || req.url;

      const fullUrl = new URL(path, `https://${host}`).toString();

      const request = new Request(fullUrl, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body:
          req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
      });

      const honoResponse = await honoApp.fetch(request);

      res.status(honoResponse.status);
      honoResponse.headers.forEach((value: string, key: string) => {
        res.set(key, value);
      });

      const body = await honoResponse.text();
      res.send(body);
    });
}
