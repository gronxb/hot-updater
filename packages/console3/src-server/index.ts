import { Hono } from "hono";
import { rpc } from "./rpc";

const app = new Hono().get("/ping", (c) => c.text("pong")).route("/rpc", rpc);

export type AppType = typeof app;

const port = 1422;

console.log(`Server running on port ${port}`);

export default {
  port,
  fetch: app.fetch,
};
