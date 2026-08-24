import { node } from "@elysiajs/node";
import { Elysia } from "elysia";

import { closeDatabase, hotUpdater } from "./db.js";

const port = Number(process.env.PORT) || 3001;
const adminToken = process.env.HOT_UPDATER_ADMIN_TOKEN;

if (!adminToken) throw new Error("HOT_UPDATER_ADMIN_TOKEN is required.");

const unauthorizedResponse = () =>
  new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });

try {
  const app = new Elysia({ adapter: node() }).get("/", () => ({
    status: "ok",
    service: "Hot Updater Server (Elysia)",
    version: "1.0.0",
  }));

  if (process.env.NODE_ENV === "test") {
    app.post("/shutdown", async () => {
      console.log("Shutdown endpoint called");
      await closeDatabase();
      setTimeout(() => process.exit(0), 100);
      return { status: "shutting down" };
    });
  }

  const adminApp = new Elysia()
    .onBeforeHandle(({ request }) => {
      if (request.headers.get("Authorization") !== `Bearer ${adminToken}`) {
        return unauthorizedResponse();
      }
    })
    .mount("/", hotUpdater.handlers.admin);

  app
    .mount("/hot-updater/admin", adminApp)
    .mount("/hot-updater", hotUpdater.handlers.client)
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
