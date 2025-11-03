import { Hono } from "hono";
import { getHotUpdater } from "./db.js";

const app = new Hono();

// Mount Hot Updater handler for all /hot-updater/* routes
app.on(["POST", "GET", "DELETE"], "/hot-updater/*", async (c) => {
  return getHotUpdater().handler(c.req.raw);
});

export default app;
