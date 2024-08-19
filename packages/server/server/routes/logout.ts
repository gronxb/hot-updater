import { Hono } from "hono";
import { lucia } from "../lib/auth.js";

import type { Context } from "../lib/context.js";

export const logoutRouter = new Hono<Context>();

logoutRouter.post("/logout", async (c) => {
  const session = c.get("session");
  if (!session) {
    return c.body(null, 401);
  }
  await lucia.invalidateSession(session.id);
  c.header("Set-Cookie", lucia.createBlankSessionCookie().serialize(), {
    append: true,
  });
  return c.redirect("/login");
});
