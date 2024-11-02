import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { rpc } from "./rpc";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const relativePathToScript = path.relative(process.cwd(), __dirname);

const app = new Hono()
  .use(
    "/static/*",
    serveStatic({
      root: relativePathToScript,
    }),
  )
  .get("*", (c) =>
    c.html(
      fs.readFileSync(path.join(relativePathToScript, "index.html"), "utf-8"),
    ),
  )
  .get("/ping", (c) => c.text("pong"))
  .route("/rpc", rpc);

export type AppType = typeof app;

export default app;
