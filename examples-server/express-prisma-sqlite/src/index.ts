import { toNodeHandler } from "@hot-updater/server/node";
import cors from "cors";
import express from "express";

import { closeDatabase, hotUpdater } from "./db";

const app = express();
const port = process.env.PORT || 3002;
const adminToken = process.env.HOT_UPDATER_ADMIN_TOKEN;

if (!adminToken) throw new Error("HOT_UPDATER_ADMIN_TOKEN is required.");

// Health check endpoint
app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "Hot Updater Server (Express)" });
});

// Hot Updater routes
app.use(
  "/hot-updater/admin",
  (req, res, next) => {
    if (req.get("Authorization") !== `Bearer ${adminToken}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    next();
  },
  express.json({ limit: "1mb" }),
  toNodeHandler(hotUpdater.handlers.admin),
);
app.use(
  "/hot-updater",
  cors(),
  express.json({ limit: "1mb" }),
  toNodeHandler(hotUpdater.handlers.client),
);

if (process.env.NODE_ENV === "test") {
  app.post("/shutdown", (_req, res) => {
    console.log("Shutdown endpoint called");
    res.json({ message: "Shutting down..." });
    server.close(() => {
      process.exit(0);
    });
  });
}

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
