import { createHotUpdater } from "@hot-updater/server";
import { Hono } from "hono";

import {
  authenticateCloudflareTelemetryKey,
  d1Database,
  parseCloudflareLifecycleRecord,
  readCloudflareTelemetryCredential,
  recordCloudflareLifecycleEvent,
  type RequestEnvContext,
  r2Storage,
  verifyJwtSignedUrl,
} from "../../src/worker";

export type CloudflareWorkerEnv = {
  DB: {
    prepare: D1Database["prepare"];
  };
  BUCKET: R2Bucket;
  JWT_SECRET: string;
};

export const HOT_UPDATER_BASE_PATH = "/api/check-update";

const resolveRequestOrigin = (context?: RequestEnvContext) => {
  const request = context?.request;

  if (!request) {
    throw new Error(
      "r2WorkerStorage requires a request to resolve publicBaseUrl.",
    );
  }

  return new URL(request.url).origin;
};

const hotUpdater = createHotUpdater({
  database: d1Database(),
  storages: [
    r2Storage({
      publicBaseUrl: resolveRequestOrigin,
    }),
  ],
  basePath: HOT_UPDATER_BASE_PATH,
  routes: {
    updateCheck: true,
    bundles: false,
  },
});

const app = new Hono<{ Bindings: CloudflareWorkerEnv }>();

app.mount(
  HOT_UPDATER_BASE_PATH,
  (request: Request, env: CloudflareWorkerEnv) => {
    return hotUpdater.handler(request, {
      request,
      env,
    });
  },
  {
    optionHandler: (c) => [c.env],
  },
);

const readJsonBody = async (request: Request): Promise<unknown | null> => {
  try {
    return await request.json();
  } catch (error: unknown) {
    if (error instanceof Error) {
      return null;
    }
    throw error;
  }
};

app.post("/api/notify-app-ready", async (c) => {
  const credential = readCloudflareTelemetryCredential(c.req.raw);
  if (credential.kind === "rejected") {
    return c.json(
      {
        error:
          credential.reason === "invalid_credential_channel"
            ? "Runtime telemetry must use x-hot-updater-telemetry-key"
            : "Telemetry key rejected",
      },
      401,
    );
  }

  const authenticated = await authenticateCloudflareTelemetryKey(
    c.env.DB,
    credential.telemetryKey,
  );
  if (!authenticated) {
    return c.json({ error: "Telemetry key rejected" }, 401);
  }

  const body = await readJsonBody(c.req.raw);
  if (body === null) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const event = parseCloudflareLifecycleRecord(body);
  if (!event) {
    return c.json({ error: "Invalid notifyAppReady payload" }, 400);
  }

  const result = await recordCloudflareLifecycleEvent(c.env.DB, event);
  return c.json(result, 202);
});

app.get("*", async (c) => {
  const result = await verifyJwtSignedUrl({
    path: c.req.path,
    token: c.req.query("token"),
    jwtSecret: c.env.JWT_SECRET,
    handler: async (storageUri) => {
      const [, ...key] = storageUri.split("/");
      const object = await c.env.BUCKET.get(key.join("/"));
      if (!object) {
        return null;
      }

      return {
        body: object.body,
        contentType: object.httpMetadata?.contentType,
      };
    },
  });

  if (result.status !== 200) {
    return c.json({ error: result.error }, result.status);
  }

  return c.body(result.responseBody, 200, result.responseHeaders);
});

export default app;
