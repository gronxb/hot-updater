import { Elysia } from "elysia";
import { node } from "@elysiajs/node";
import { closeDatabase, hotUpdater } from "./db.js";

const port = Number(process.env.PORT) || 3001;

const isAuthorizedManagementRequest = (request: Request) => {
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

try {
  const app = new Elysia({ adapter: node() })
    .get("/", () => ({
      status: "ok",
      service: "Hot Updater Server (Elysia)",
      version: "1.0.0",
    }))
    .post("/shutdown", async () => {
      console.log("Shutdown endpoint called");
      await closeDatabase();
      setTimeout(() => process.exit(0), 100);
      return { status: "shutting down" };
    })
    .all("/hot-updater/*", ({ request }) => {
      if (
        new URL(request.url).pathname.startsWith("/hot-updater/api/") &&
        !isAuthorizedManagementRequest(request)
      ) {
        return unauthorizedResponse();
      }

      return hotUpdater.handler(request);
    })
    .listen(port);

  console.log(`
╭─────────────────────────────────────╮
│  Hot Updater Server (Elysia)       │
│  Running on http://localhost:${port}  │
╰─────────────────────────────────────╯
  `);

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    console.log("SIGTERM received, closing server...");
    await closeDatabase();
    app.stop();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    console.log("SIGINT received, closing server...");
    await closeDatabase();
    app.stop();
    process.exit(0);
  });
} catch (error) {
  console.error("Failed to start server:", error);
  process.exit(1);
}
