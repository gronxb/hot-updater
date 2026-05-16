import { Hono } from "hono";

import { hotUpdater } from "./db.js";

const app = new Hono();

const isAuthorizedManagementRequest = (request: Request) => {
  if (process.env.NODE_ENV === "test") {
    return true;
  }

  const token = process.env.HOT_UPDATER_AUTH_TOKEN;
  return (
    Boolean(token) && request.headers.get("Authorization") === `Bearer ${token}`
  );
};

app.use("/hot-updater/api/*", async (c, next) => {
  if (!isAuthorizedManagementRequest(c.req.raw)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
});

// Mount Hot Updater handler for all /hot-updater/* routes
app.on(["GET", "POST", "PATCH", "DELETE"], "/hot-updater/*", async (c) => {
  return hotUpdater.handler(c.req.raw);
});

export default app;
