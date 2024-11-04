import path from "path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { rpc } from "./rpc";

const relativePathToScript = path.relative(process.cwd(), __dirname);

const app = new Hono()
  .get("/ping", (c) => c.text("pong"))
  .route("/rpc", rpc)
  .use(
    "/static/*",
    serveStatic({
      root: relativePathToScript,
    }),
  )
  .get(
    "*",
    serveStatic({
      root: relativePathToScript,
      path: "index.html",
    }),
  );

export type AppType = typeof app;

export default app;
