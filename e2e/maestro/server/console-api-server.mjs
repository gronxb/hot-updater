import { serve } from "@hono/node-server";
import app from "../../../packages/console/dist/index.mjs";

const hostname = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 1422);

serve(
  {
    fetch: app.fetch,
    hostname,
    port,
  },
  (info) => {
    console.log(
      `Hot Updater Console API listening on http://${hostname}:${info.port}`,
    );
  },
);

const shutdown = () => {
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
