import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { closeDatabase } from "../../../examples-server/hono-e2e-local/src/db.js";
import storageRoutes from "../../../examples-server/hono-e2e-local/src/routes.js";
import e2eRoutes from "./routes.js";

const app = new Hono();
let isClosing = false;

async function closeServerDatabase() {
  if (isClosing) {
    return;
  }

  isClosing = true;
  try {
    await closeDatabase();
  } catch {}
}

app.use("*", logger());
app.use("*", cors());

app.get("/", (c) => {
  return c.json({
    service: "Hot Updater E2E Local Server",
    status: "ok",
    version: "1.0.0",
  });
});

app.post("/shutdown", async (c) => {
  await closeServerDatabase();
  setTimeout(() => process.exit(0), 100);
  return c.json({ status: "shutting down" });
});

app.route("/", storageRoutes);
app.route("/", e2eRoutes);

const port = Number(process.env.PORT) || 3007;

try {
  serve(
    {
      fetch: app.fetch,
      port,
    },
    (info) => {
      console.log(
        `Hot Updater E2E Local Server listening on http://localhost:${info.port}`,
      );
    },
  );

  process.on("SIGTERM", async () => {
    await closeServerDatabase();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await closeServerDatabase();
    process.exit(0);
  });
} catch (error) {
  console.error("Failed to start E2E server:", error);
  process.exit(1);
}
