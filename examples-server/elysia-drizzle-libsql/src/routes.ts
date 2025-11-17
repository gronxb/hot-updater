import { Elysia } from "elysia";
import { hotUpdater } from "./db.js";

const app = new Elysia();

// Mount Hot Updater handler for all /api/* routes
app.all("/api/*", ({ request }) => {
  return hotUpdater.handler(request);
});

export default app;
