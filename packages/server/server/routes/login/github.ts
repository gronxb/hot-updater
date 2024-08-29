import { identifier } from "@electric-sql/pglite/template";
import { OAuth2RequestError, generateState } from "arctic";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { generateId } from "lucia";
import { github, lucia } from "../../lib/auth.js";
import { db } from "../../lib/db.js";

import type { Context } from "../../lib/context.js";
import type { DatabaseUser } from "../../lib/db.js";

export const githubLoginRouter = new Hono<Context>();

githubLoginRouter.get("/login/github", async (c) => {
  const state = generateState();
  const url = await github.createAuthorizationURL(state);
  setCookie(c, "github_oauth_state", state, {
    path: "/",
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    maxAge: 60 * 10,
    sameSite: "Lax",
  });
  return c.redirect(url.toString());
});

githubLoginRouter.get("/login/github/callback", async (c) => {
  console.log("callback");
  const code = c.req.query("code")?.toString() ?? null;
  const state = c.req.query("state")?.toString() ?? null;
  const storedState = getCookie(c).github_oauth_state ?? null;
  if (!code || !state || !storedState || state !== storedState) {
    return c.body(null, 400);
  }
  try {
    const tokens = await github.validateAuthorizationCode(code);
    const githubUserResponse = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
      },
    });
    const githubUser: GitHubUser = await githubUserResponse.json();
    const results =
      await db.sql`SELECT * FROM user WHERE github_id = ${identifier`${githubUser.id}`} LIMIT 1`;
    const existingUser = results.rows[0] as DatabaseUser | null;

    if (existingUser) {
      const session = await lucia.createSession(existingUser.id, {});
      c.header(
        "Set-Cookie",
        lucia.createSessionCookie(session.id).serialize(),
        { append: true },
      );
      return c.redirect("/");
    }

    const userId = generateId(15);
    await db.query(
      "INSERT INTO user (id, github_id, username, avatar_url, email) VALUES ($1, $2, $3, $4, $5)",
      [
        userId,
        githubUser.id,
        githubUser.login,
        githubUser.avatar_url,
        githubUser.email,
      ],
    );
    const session = await lucia.createSession(userId, {});
    c.header("Set-Cookie", lucia.createSessionCookie(session.id).serialize(), {
      append: true,
    });
    return c.redirect("/");
  } catch (e) {
    if (
      e instanceof OAuth2RequestError &&
      e.message === "bad_verification_code"
    ) {
      // invalid code
      return c.body(null, 400);
    }
    return c.body(null, 500);
  }
});

interface GitHubUser {
  id: string;
  login: string;
  avatar_url: string;
  name: string;
  email: string;
}
