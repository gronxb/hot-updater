import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import e2eRoutes from "./routes.ts";

const app = new Hono();

app.use("*", logger());
app.use("*", cors());

app.get("/", (c) => {
  return c.json({
    service: "Hot Updater Maestro Control Server",
    status: "ok",
    version: "1.0.0",
  });
});

app.post("/shutdown", async (c) => {
  setTimeout(() => process.exit(0), 100);
  return c.json({ status: "shutting down" });
});

app.route("/", e2eRoutes);

const port = Number(
  process.env.PORT || process.env.HOT_UPDATER_E2E_CONTROL_PORT || 3107,
);
const hostname = process.env.HOT_UPDATER_E2E_SERVER_HOST || "127.0.0.1";

try {
  serve(
    {
      fetch: app.fetch,
      hostname,
      port,
    },
    (info) => {
      console.log(
        `Hot Updater Maestro Control Server listening on http://${hostname}:${info.port}`,
      );
    },
  );

  process.on("SIGTERM", async () => {
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    process.exit(0);
  });
} catch (error) {
  console.error("Failed to start E2E server:", error);
  process.exit(1);
}
