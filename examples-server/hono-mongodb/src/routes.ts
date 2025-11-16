import { Hono } from "hono";
import { hotUpdater } from "./db.js";

const app = new Hono();

// Example: Add authentication middleware for console
app.use("/console/*", async (c, next) => {
  // Add your authentication logic here
  // For example:
  // const token = c.req.header("authorization");
  // if (!token || !await verifyToken(token)) {
  //   return c.json({ error: "Unauthorized" }, 401);
  // }
  await next();
});

// Mount Console handler (with authentication middleware above)
app.on(["POST", "GET", "DELETE", "PATCH"], "/console/*", async (c) => {
  return hotUpdater.console.handler(c.req.raw);
});

// Mount Hot Updater API handler (no authentication)
app.on(["POST", "GET", "DELETE"], "/hot-updater/*", async (c) => {
  return hotUpdater.handler(c.req.raw);
});

export default app;
