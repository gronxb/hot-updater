import { NIL_UUID } from "@hot-updater/core";
import { verifyJwtSignedUrl, withJwtSignedUrl } from "@hot-updater/js";
import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v1";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { getUpdateInfo } from "./getUpdateInfo";

declare global {
  var HotUpdater: {
    REGION: string;
    BUCKET_NAME?: string;
    JWT_SECRET: string;
  };
}

if (!admin.apps.length) {
  admin.initializeApp();
}

export function validatePlatform(platform: string): "ios" | "android" | null {
  const validPlatforms = ["ios", "android"];
  return validPlatforms.includes(platform)
    ? (platform as "ios" | "android")
    : null;
}

function getHostUrl(host: string | null): string {
  const projectId = admin.app().options.projectId;

  if (!host) {
    const defaultRegion = HotUpdater.REGION;
    return `https://${defaultRegion}-${projectId}.cloudfunctions.net`;
  }

  const hostWithProtocol = host.includes("://") ? host : `https://${host}`;
  const url = new URL(hostWithProtocol);

  if (url.hostname.includes(".cloudfunctions.net")) {
    return `https://${url.hostname}`;
  }

  const defaultRegion = HotUpdater.REGION;
  return `https://${defaultRegion}-${projectId}.cloudfunctions.net`;
}

async function getSignedUrlWithCorrectFormat(params: {
  data: any;
  reqUrl: string;
  jwtSecret: string;
}) {
  const result = await withJwtSignedUrl(params);

  if (result?.fileUrl) {
    const functionName = "hot-updater";

    try {
      const url = new URL(result.fileUrl);
      const pathSegments = url.pathname.split("/").filter(Boolean);

      const newPathname = `/${functionName}/${pathSegments.join("/")}`;

      const newUrl = new URL(newPathname, `${url.protocol}//${url.host}`);
      newUrl.search = url.search;

      result.fileUrl = newUrl.toString();
    } catch (error) {
      console.error("URL Parsing Error:", error);
    }
  }

  return result;
}

const app = new Hono();

app.use("*", async (c, next) => {
  console.log(`Original path: ${c.req.path}`);

  const path = c.req.path.replace(/^\/hot-updater/, "");

  if (path === "") {
    c.req.path = "/";
  } else {
    c.req.path = path;
  }

  console.log(`Modified path: ${c.req.path}`);

  await next();
});

app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: [
      "Content-Type",
      "x-app-platform",
      "x-app-version",
      "x-bundle-id",
      "x-min-bundle-id",
      "x-channel",
    ],
    allowMethods: ["GET", "OPTIONS"],
  }),
);

app.get("", (c) => {
  return c.text("pong");
});

app.get("/api/check-update", async (c) => {
  try {
    const platformHeader = c.req.header("x-app-platform");
    const appVersion = c.req.header("x-app-version");
    const bundleId = c.req.header("x-bundle-id");
    const minBundleId = c.req.header("x-min-bundle-id");
    const channel = c.req.header("x-channel");

    if (!platformHeader || !appVersion || !bundleId) {
      return c.json(
        {
          error:
            "Missing required headers (x-app-platform, x-app-version, x-bundle-id)",
        },
        400,
      );
    }

    const platform = validatePlatform(platformHeader);
    if (!platform) {
      return c.json(
        {
          error: "Invalid platform. Must be 'ios' or 'android'",
        },
        400,
      );
    }

    const db = admin.firestore();
    const updateInfo = await getUpdateInfo(db, {
      platform,
      appVersion,
      bundleId,
      minBundleId: minBundleId || NIL_UUID,
      channel: channel || "production",
    });

    if (!updateInfo) {
      return c.json(null, 200);
    }

    let fileHash = null;

    if (updateInfo.id !== NIL_UUID && updateInfo.status !== "ROLLBACK") {
      try {
        const bundleDoc = await db
          .collection("bundles")
          .doc(updateInfo.id)
          .get();
        const bundleData = bundleDoc.data();

        if (bundleData) {
          fileHash = bundleData.file_hash || null;
        }
      } catch (error) {
        console.error("Error fetching bundle data:", error);
      }
    }

    const responseData = {
      ...updateInfo,
      fileHash,
    };

    const hostname = c.req.raw.headers.get("host");
    const hostUrl = getHostUrl(hostname);

    const appUpdateInfo = await getSignedUrlWithCorrectFormat({
      data: responseData,
      reqUrl: hostUrl,
      jwtSecret: HotUpdater.JWT_SECRET,
    });

    return c.json(appUpdateInfo, 200);
  } catch (error: unknown) {
    console.error("Update check error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

app.get("*", async (c) => {
  try {
    const path = c.req.path.substring(1);
    const token = c.req.query("token");

    console.log(`File download request: ${path}, token: ${token}`);

    const result = await verifyJwtSignedUrl({
      path,
      token,
      jwtSecret: HotUpdater.JWT_SECRET,
      handler: async (key) => {
        try {
          const bucket = admin.storage().bucket(HotUpdater.BUCKET_NAME);
          const file = bucket.file(key);

          const [exists] = await file.exists();
          if (!exists) {
            console.error(`File not found: ${key}`);
            return null;
          }

          const [metadata] = await file.getMetadata();
          const [fileContent] = await file.download();

          return {
            body: fileContent,
            contentType: metadata.contentType || "application/octet-stream",
          };
        } catch (error) {
          console.error("Error retrieving file from storage:", error);
          return null;
        }
      },
    });

    if (result.status !== 200) {
      return c.json({ error: result.error }, result.status);
    }

    if (result.responseHeaders) {
      for (const [key, value] of Object.entries(result.responseHeaders)) {
        c.header(key, value);
      }
    }

    return new Response(result.responseBody, {
      status: 200,
      headers: c.res.headers,
    });
  } catch (error: unknown) {
    console.error("Error in bundle download process:", error);
    return c.json(
      {
        error: "Internal Server Error",
      },
      500,
    );
  }
});

const hotUpdaterFunction = functions
  .region(HotUpdater.REGION)
  .https.onRequest(async (req: functions.Request, res: functions.Response) => {
    const host = req.hostname || "localhost";
    const protocol = req.protocol || "https";
    const fullUrl = `${protocol}://${host}${req.originalUrl || req.url}`;

    const request = new Request(fullUrl, {
      method: req.method,
      headers: req.headers as HeadersInit,
      body:
        req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
    });

    try {
      const honoResponse = await app.fetch(request);

      res.status(honoResponse.status);

      honoResponse.headers.forEach((value: string, key: string) => {
        res.set(key, value);
      });

      const body = await honoResponse.text();
      res.send(body);
    } catch (error: unknown) {
      console.error("Hono app error:", error);
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      res
        .status(500)
        .json({ error: "Internal Server Error", details: errorMessage });
    }
  });

export const hot = {
  updater: hotUpdaterFunction,
};
