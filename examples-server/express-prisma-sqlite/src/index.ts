import cors from "cors";
import express from "express";
import { closeDatabase, hotUpdater } from "./db";
import { toNodeHandler } from "@hot-updater/server/node";

const app = express();
const port = process.env.PORT || 3002;

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "Hot Updater Server (Express)" });
});

// Hot Updater routes
app.all("/hot-updater/*", toNodeHandler(hotUpdater));

// Shutdown endpoint for testing
app.post("/shutdown", (_req, res) => {
  console.log("Shutdown endpoint called");
  res.json({ message: "Shutting down..." });
  server.close(() => {
    process.exit(0);
  });
});

// Start server
const server = app.listen(port, () => {
  console.log(`
╭─────────────────────────────────────╮
│  Hot Updater Server (Express)      │
│  Running on http://localhost:${port}  │
╰─────────────────────────────────────╯
  `);
});

// Graceful shutdown handlers
async function gracefulShutdown(signal: string) {
  console.log(`\n${signal} received. Closing server gracefully...`);

  server.close(async () => {
    console.log("HTTP server closed.");

    try {
      await closeDatabase();
      console.log("Database connections closed.");
      process.exit(0);
    } catch (error) {
      console.error("Error closing database:", error);
      process.exit(1);
    }
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    console.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
