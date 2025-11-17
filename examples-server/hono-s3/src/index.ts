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
    service: "Hot Updater Server (Hono + S3)",
    version: "1.0.0",
  });
});

// Shutdown endpoint for tests
app.post("/shutdown", async (c) => {
  console.log("Shutdown endpoint called");
  await closeDatabase();
  setTimeout(() => process.exit(0), 100);
  return c.json({ status: "shutting down" });
});

// Mount API routes
app.route("/", routes);

// Start server
const port = Number(process.env.PORT) || 3007;

try {
  serve(
    {
      fetch: app.fetch,
      port,
    },
    (info) => {
      console.log(`
╭─────────────────────────────────────╮
│  Hot Updater Server (Hono + S3)    │
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
