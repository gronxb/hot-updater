import { Elysia } from "elysia";
import { api } from "./db.js";

const app = new Elysia();

// Mount Hot Updater handler for all /api/* routes
app.all("/api/*", ({ request }) => {
  return api.handler(request);
});

export default app;
