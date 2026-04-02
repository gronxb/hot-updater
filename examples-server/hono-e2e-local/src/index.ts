import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { closeDatabase } from "./db.js";
import { requestLogger } from "./requestLogger.js";
import routes from "./routes.js";

const app = new Hono();

app.use("*", requestLogger());
app.use("*", cors());

app.get("/", (c) => {
  return c.json({
    service: "Hot Updater E2E Local Server",
    status: "ok",
    version: "1.0.0",
  });
});

app.post("/shutdown", async (c) => {
  await closeDatabase();
  setTimeout(() => process.exit(0), 100);
  return c.json({ status: "shutting down" });
});

app.route("/", routes);

const port = Number(process.env.PORT) || 3007;

try {
  serve(
    {
      fetch: app.fetch,
      port,
    },
    (info) => {
      console.log(`Hot Updater E2E Local Server listening on http://localhost:${info.port}`);
    },
  );

  process.on("SIGTERM", async () => {
    await closeDatabase();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await closeDatabase();
    process.exit(0);
  });
} catch (error) {
  console.error("Failed to start E2E server:", error);
  process.exit(1);
}
