import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

import routes from "./routes.js";

const app = new Hono();

app.use("*", cors());
app.get("/", (c) =>
  c.json({
    status: "ok",
    service: "Hot Updater Server (Hono + DynamoDB)",
    version: "1.0.0",
  }),
);
app.route("/", routes);

const port = Number(process.env.PORT) || 3007;

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Hot Updater DynamoDB server listening on ${info.port}`);
});
