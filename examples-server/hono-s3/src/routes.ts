import { Hono } from "hono";

import { hotUpdater } from "./db.js";

const app = new Hono();

const isAuthorizedManagementRequest = (request: Request) => {
  const token = process.env.HOT_UPDATER_AUTH_TOKEN;
  return (
    Boolean(token) && request.headers.get("Authorization") === `Bearer ${token}`
  );
};

app.use("/hot-updater/api/*", async (c, next) => {
  if (!isAuthorizedManagementRequest(c.req.raw)) {
    const authorization = c.req.raw.headers.get("Authorization");
    console.warn("[hono-s3] unauthorized management request", {
      authorizationLength: authorization?.length ?? 0,
      hasAuthorization: Boolean(authorization),
      hasToken: Boolean(process.env.HOT_UPDATER_AUTH_TOKEN),
      tokenLength: process.env.HOT_UPDATER_AUTH_TOKEN?.length ?? 0,
    });
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
});

// Mount Hot Updater handler for all /hot-updater/* routes
app.on(["GET", "POST", "PATCH", "DELETE"], "/hot-updater/*", async (c) => {
  return hotUpdater.handler(c.req.raw);
});

export default app;
