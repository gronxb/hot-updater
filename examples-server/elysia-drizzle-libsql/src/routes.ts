import { Elysia } from "elysia";
import { hotUpdater } from "./db.js";

const app = new Elysia();

const isAuthorizedManagementRequest = (request: Request) => {
  if (process.env.NODE_ENV === "test") {
    return true;
  }

  const token = process.env.HOT_UPDATER_AUTH_TOKEN;
  return (
    Boolean(token) && request.headers.get("Authorization") === `Bearer ${token}`
  );
};

const unauthorizedResponse = () =>
  new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });

// Mount Hot Updater handler for all /api/* routes
app.all("/api/*", ({ request }) => {
  if (!isAuthorizedManagementRequest(request)) {
    return unauthorizedResponse();
  }

  return hotUpdater.handler(request);
});

export default app;
