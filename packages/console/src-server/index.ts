import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { api } from "./api";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const relativePathToScript = import.meta.env.PROD
  ? path.relative(process.cwd(), __dirname)
  : "/";

// In production, static assets are copied to dist/ alongside this file
// In dev, assets are served from memory by Vite
const app = new Hono()
  .get("/ping", (c) => c.text("pong"))
  .route("/api", api)
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
