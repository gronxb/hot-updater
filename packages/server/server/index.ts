import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { AppLoadContext, ServerBuild } from "@remix-run/node";
import { Hono } from "hono";
import { verifyRequestOrigin } from "lucia";
import { remix } from "./dev/handler";
import { importDevBuild } from "./dev/server";
import { lucia } from "./lib/auth";
import type { Context } from "./lib/context";
import { githubLoginRouter } from "./routes/login/github";
import { logoutRouter } from "./routes/logout";

const mode =
  process.env.NODE_ENV === "test" ? "development" : process.env.NODE_ENV;
const isProductionMode = mode === "production";

const app = new Hono<Context>();

/**
 * Serve assets files from build/client/assets
 */
app.use("/assets/*", serveStatic({ root: "./build/client" }));

/**
 * Serve public files
 */
app.use(
  "*",
  serveStatic({ root: isProductionMode ? "./build/client" : "./public" }),
);

/**
 * Lucia CSRF
 */
app.use("*", async (c, next) => {
  if (c.req.method === "GET") {
    return next();
  }
  const originHeader = c.req.header("Origin") ?? null;
  const hostHeader = c.req.header("Host") ?? null;
  if (
    !originHeader ||
    !hostHeader ||
    !verifyRequestOrigin(originHeader, [hostHeader])
  ) {
    return c.body(null, 403);
  }
  return next();
});

/**
 * Lucia session
 */
app.use("*", async (c, next) => {
  const sessionId = lucia.readSessionCookie(c.req.header("Cookie") ?? "");
  if (!sessionId) {
    c.set("user", null);
    c.set("session", null);
    return next();
  }

  const { session, user } = await lucia.validateSession(sessionId);
  if (session?.fresh) {
    c.header("Set-Cookie", lucia.createSessionCookie(session.id).serialize(), {
      append: true,
    });
  }
  if (!session) {
    c.header("Set-Cookie", lucia.createBlankSessionCookie().serialize(), {
      append: true,
    });
  }
  c.set("user", user);
  c.set("session", session);
  return next();
});

app.route("/api", githubLoginRouter);
app.route("/api", logoutRouter);

/**
 * Add remix middleware to Hono server
 */
app.use(async (c, next) => {
  const build = (isProductionMode
    ? // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      // eslint-disable-next-line import/no-unresolved -- this expected until you build the app
      await import("../build/server/remix.js")
    : await importDevBuild()) as unknown as ServerBuild;

  return remix({
    build,
    mode,
    getLoadContext() {
      return {
        session: c.get("session"),
        user: c.get("user"),
      } satisfies AppLoadContext;
    },
  })(c, next);
});

// /**
//  * Start the production server
//  */

// if (isProductionMode) {
//   serve(
//     {
//       ...app,
//       port: Number(process.env.PORT) || 5173,
//     },
//     async (info) => {
//       console.log(`🚀 Server started on port ${info.port}`);
//     },
//   );
// }

export default app;
