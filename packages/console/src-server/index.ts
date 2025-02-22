import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { rpc } from "./rpc";

const app = new Hono()
  .get("/ping", (c) => c.text("pong"))
  .route("/rpc", rpc)
  .get(
    "/",
    serveStatic({
      root: "/",
      path: "index.html",
    }),
  );

export type AppType = typeof app;

export default app;
