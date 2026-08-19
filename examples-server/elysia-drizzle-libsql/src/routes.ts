import { Elysia } from "elysia";

import { hotUpdater } from "./db.js";

const app = new Elysia();
const adminToken = process.env.HOT_UPDATER_ADMIN_TOKEN;

if (!adminToken) throw new Error("HOT_UPDATER_ADMIN_TOKEN is required.");

const unauthorizedResponse = () =>
  new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });

const adminApp = new Elysia()
  .onBeforeHandle(({ request }) => {
    if (request.headers.get("Authorization") !== `Bearer ${adminToken}`) {
      return unauthorizedResponse();
    }
  })
  .mount("/", hotUpdater.handlers.admin);

app
  .mount("/hot-updater/admin", adminApp)
  .mount("/hot-updater", hotUpdater.handlers.client);

export default app;
