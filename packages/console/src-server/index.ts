import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import path from "path";
import { fileURLToPath } from "url";
import { rpc } from "./rpc";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const relativePathToScript = import.meta.env.PROD
  ? path.relative(process.cwd(), __dirname)
  : "/";

const app = new Hono()
  .get("/ping", (c) => c.text("pong"))
  .route("/rpc", rpc)
  .use(
    "/assets/*",
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
