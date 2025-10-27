import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { closeDatabase } from "./db.js";
import routes from "./routes.js";

const app = new Hono();

// Middleware
app.use("*", logger());
app.use("*", cors());

// Health check
app.get("/", (c) => {
  return c.json({
    status: "ok",
    service: "Hot Updater Server (Hono)",
    version: "1.0.0",
  });
});

// Mount API routes
app.route("/", routes);

// Start server
const port = Number(process.env.PORT) || 3000;

try {
  serve(
    {
      fetch: app.fetch,
      port,
    },
    (info) => {
      console.log(`
╭─────────────────────────────────────╮
│  Hot Updater Server (Hono)         │
│  Running on http://localhost:${info.port}  │
╰─────────────────────────────────────╯
      `);
    },
  );

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    console.log("SIGTERM received, closing server...");
    await closeDatabase();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    console.log("SIGINT received, closing server...");
    await closeDatabase();
    process.exit(0);
  });
} catch (error) {
  console.error("Failed to start server:", error);
  process.exit(1);
}
