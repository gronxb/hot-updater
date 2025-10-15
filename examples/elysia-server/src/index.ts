import { Elysia } from "elysia";
import { node } from "@elysiajs/node";
import { closeDatabase, initializeDatabase } from "./db.js";
import { api } from "./db.js";

const port = Number(process.env.PORT) || 3001;

try {
  await initializeDatabase();

  const app = new Elysia({ adapter: node() })
    .get("/", () => ({
      status: "ok",
      service: "Hot Updater Server (Elysia)",
      version: "1.0.0",
    }))
    .mount("/api", api.handler)
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
