import { Hono } from "hono";
import { api } from "./db.js";

const app = new Hono();

// Mount Hot Updater handler for all /api/* routes
app.on(["POST", "GET", "DELETE"], "/api/*", async (c) => {
  return api.handler(c.req.raw);
});

export default app;
