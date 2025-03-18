import { NIL_UUID } from "@hot-updater/core";
import { Hono } from "hono";
import { type JWTPayload, SignJWT, jwtVerify } from "jose";
import { getUpdateInfo } from "./getUpdateInfo";

type Env = {
  DB: D1Database;
  BUCKET: R2Bucket;
  JWT_SECRET: string;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/api/check-update", async (c) => {
  const bundleId = c.req.header("x-bundle-id") as string;
  const appPlatform = c.req.header("x-app-platform") as "ios" | "android";
  const appVersion = c.req.header("x-app-version") as string;
  const minBundleId = c.req.header("x-min-bundle-id") as string | undefined;
  const channel = c.req.header("x-channel") as string | undefined;

  if (!bundleId || !appPlatform || !appVersion) {
    return c.json(
      { error: "Missing bundleId, appPlatform, or appVersion" },
      400,
    );
  }

  const updateInfo = await getUpdateInfo(c.env.DB, {
    appVersion,
    bundleId,
    platform: appPlatform,
    minBundleId: minBundleId || NIL_UUID,
    channel: channel || "production",
  });

  if (!updateInfo) {
    return c.json(null, 200);
  }

  if (updateInfo.id === NIL_UUID) {
    return c.json({ ...updateInfo, fileUrl: null }, 200);
  }

  const key = `${updateInfo.id}/bundle.zip`;

  const secretKey = new TextEncoder().encode(c.env.JWT_SECRET);
  const token = await new SignJWT({ key })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("60s")
    .sign(secretKey);

  const requestUrl = new URL(c.req.url);
  requestUrl.pathname = `/${key}`;
  requestUrl.searchParams.set("token", token);

  return c.json({ ...updateInfo, fileUrl: requestUrl.toString() }, 200);
});

app.get("*", async (c) => {
  const key = c.req.path.replace(/^\/+/, "");
  const token = c.req.query("token");
  if (!token) {
    return c.text("Missing token", 400);
  }
  let payload: JWTPayload;
  try {
    const secretKey = new TextEncoder().encode(c.env.JWT_SECRET);
    const { payload: verifiedPayload } = await jwtVerify(token, secretKey);
    payload = verifiedPayload;
  } catch (err) {
    return c.text("Invalid or expired token", 403);
  }

  if (!payload || payload.key !== key) {
    return c.text("Token does not match requested file", 403);
  }
  const object = await c.env.BUCKET.get(key);
  if (!object) {
    return c.text("File not found", 404);
  }

  const pathParts = key.split("/");
  const fileName = pathParts[pathParts.length - 1];

  return new Response(object.body, {
    headers: {
      "Content-Type":
        object.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": `attachment; filename=${fileName}`,
    },
  });
});

export default app;
