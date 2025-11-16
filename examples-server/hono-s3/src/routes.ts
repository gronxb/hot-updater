import { Hono } from "hono";
import { hotUpdater } from "./db.js";

const app = new Hono();

// Mount Hot Updater handler for all /hot-updater/* routes
app.on(["POST", "GET", "DELETE"], "/hot-updater/*", async (c) => {
  return hotUpdater.handler(c.req.raw);
});

export default app;

